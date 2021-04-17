/**
  * A map of class ids and the regular expressions that capture the text to style
  */
const regExps = {
    errorStack: /^Traceback.*\r?\n(?:^\s+.*\r?\n)+/gm,  // Error stack
    error: /^\w*(Error|Exception).*\r?\n/gm,  // Error statement
    warning: /\w*Warning:.*\r?\n(?:^\s+.*\r?\n)/gm,  // Warning
    logDebug: /.*DEBUG.*\r?\n(?:^\s+.*\r?\n)*/gm,  // log.debug
    logInfo: /.*INFO.*\r?\n(?:^\s+.*\r?\n)*/gm,  // log.info
    logWarn: /.*WARNING.*\r?\n(?:^\s+.*\r?\n)*/gm,  // log.warning
    logError: /.*ERROR.*\r?\n(?:^\s+.*\r?\n)*/gm,  // log.error
    logCritical: /.*CRITICAL.*\r?\n(?:^\s+.*\r?\n)*/gm,  // log.critical
    flake8: /^[a-zA-Z\/\\._]+:\d+:\d+: [EWF]\d{3} .*$/gm  // flake8 error
};
const cursor = '<span class="blinking-cursor">&#9608;</span>';
let timer = null;
let lastModified = null;
const id = window.location.pathname.split('/').pop();
const heading = 'Job log for commit ' + shortID(id);
document.addEventListener('DOMContentLoaded', function() {
    document.querySelector('h1').innerText = heading;
}, false);

/**
 * Given some text and a class name, return the text wrapped in a span of that class.
 */
function toSpan(text, className) {
   return '<span class="' + className + '">' + text + '</span>';
}

function escapeHTML(str){
    return new Option(str).innerHTML;
}

/**
 * Return a shortened version of an int or string id
 * @param {any} v - ID to shorten.
 * @param {int} len - Maximum number of chars.
 * @returns {String} v as a short string.
 */
function shortID(v, len=7) {
   if (Array.isArray(v)) { return v.map(v => shortID(v, len)); }
   if (Number.isInteger(v)) { v = v.toString(); }
   if (typeof v === 'string' || v instanceof String) { v = v.substr(0, len); }
   return v;  // If not string, array or number, leave unchanged
}

/**
 * Fetch the raw log text from remote.
 */
async function updateLog() {
    const contentDiv = document.querySelector('pre');
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);

    const url = '/logs/raw/' + id;
    // If the console is empty, add some loading text
    if (!contentDiv.innerHTML) {
       contentDiv.innerHTML = 'Loading log....' + cursor;
    }

    // Fetch the remote log text
    console.debug('Reloading log');
    let options = {};
    if (lastModified) {
        options['headers'] = { 'If-Modified-Since': lastModified };
    }
    if (urlParams.has('type')) {
        options['query'] = {'type': urlParams.get('type')};
    }

    let response = await fetch(url, options);
    if (response.status === 304) {
        console.debug('Log unchanged');
        return;
    } else if (response.status !== 200) {
        console.error('Failed to return the log file');
        // If never loaded, change console text
        if (!lastModified) {
            contentDiv.innerHTML = toSpan('ERROR: Failed to load log', 'error');
        }
        return;
    }
    lastModified = response.headers.get('Last-Modified');
    const jobStatus = response.headers.get('X-CI-JobStatus');
    let log = await (response).text();
    log = escapeHTML(log);

    // Apply the regex for styling/highlighting the text
    // http://ascii-table.com/ansi-escape-sequences-vt-100.php
    if (urlParams.get('formatting') !== 'off') {
        log = log.replace(/\x1b?\[\d+m/gm, '');  // Remove ANSI color codes
        for (let style in regExps) {
           log = log.replace(regExps[style], x => toSpan(x, style));
        }
    }

    // If not static, add a little blinking cursor to indicate activity
    const isRunning = ['queued', 'running'].includes(jobStatus);
    if (isRunning) { log += cursor; }

    // Check if you're at the bottom
    const elem = document.getElementById('console');
    const atBottom = elem.scrollHeight - elem.scrollTop === elem.clientHeight;

    // Update console text
    contentDiv.innerHTML = log;

    // If you were at the bottom, update scroll position
    if (atBottom) {
        console.debug('Setting scroll height')
        elem.scrollTop = elem.scrollHeight;
    }

    // Set title, etc.
    const header = document.querySelector('h1');
    header.innerText = `${heading} | ${jobStatus.toUpperCase()}`;
    document.title = `Job ${jobStatus} for commit ${shortID(id)}`;
    document.getElementById('date').innerText = new Date(lastModified).toLocaleString();

    if (!timer && (urlParams.has('refresh') || isRunning)) {
        console.debug('Setting reload timer');
        const timeout = (urlParams.get('refresh') || 2) * 1000;  // default 2 sec
        const minTimeout = 500;  // ms
        timer = setInterval(updateLog, Math.max(timeout, minTimeout));
    } else if (response.ok && jobStatus === 'finished' && timer) {
        console.debug('Clearing reload timer');
        clearInterval(timer);
        timer = null;
    }

}

document.addEventListener('DOMContentLoaded', updateLog, false);
