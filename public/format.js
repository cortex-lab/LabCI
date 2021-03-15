/**
  * A map of class ids and the regular expressions that capture the text to style
  */
const regExps = {
    errorStack: /'^Traceback.*?(?=\n\S)'/gms,  // Error stack
    error: /^\w*Error.*?(?=\n\S)/gms,  // Error statement
    warning: /Warning:.*?(?=\n\S)/gms,  // Warning
    logInfo: /\[.*INFO.*\r?\n(?:^\s+.*\r?\n)*/gm,  // log.info
    logWarn: /\[.*WARNING.*\r?\n(?:^\s+.*\r?\n)*/gm,  // log.warning
    logError: /\[.*ERROR.*\r?\n(?:^\s+.*\r?\n)*/gm,  // log.error
    logCritical: /\[.*CRITICAL.*\r?\n(?:^\s+.*\r?\n)*/gm  // log.critical
};
const cursor = '<span class="blinking-cursor">&#9608;</span>';
let timer = null;
let lastModified = null;


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
 * Fetch the raw log text from remote.
 */
async function updateLog() {
    const contentDiv = document.querySelector('pre');
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    const id = window.location.pathname.split('/').pop();
    if (!id) {
        contentDiv.innerHTML = 'ERROR: Log not found';
        return;
    }

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

    let response = await fetch(url, options);
    if (response.status === 304) {
        console.debug('Log unchanged');
        return;
    } else if (response.status !== 200) {
        console.error('Failed to return the log file');
        return;
    }
    lastModified = response.headers.get('Last-Modified');
    let log = await (response).text();
    log = escapeHTML(log);

    // Apply the regex for styling/highlighting the text
    log = log.replace(/\x1b?\[0m/gm, '');  // Remove escape chars
    for (let style in regExps) {
       log = log.replace(regExps[style], x => toSpan(x, style));
    }

    // If not static, add a little blinking cursor to indicate activity
    if (urlParams.has('autoupdate')) { log += cursor; }

    // Update console text
    contentDiv.innerHTML = log;

    // Check if you're at the bottom
    const elem = document.getElementById('console');
    const atBottom = elem.scrollHeight - elem.scrollTop === elem.clientHeight;

    // If you were at the bottom, update scroll position
    if (atBottom) {
        elem.scrollTop = elem.scrollHeight;
    }

    // Call recursively
    const jobStatus = response.headers.get('X-CI-JobStatus');
    console.debug(jobStatus);

    if (!timer && urlParams.has('autoupdate')) {
        console.debug('Setting reload timer');
        const timeout = urlParams.get('autoupdate') || 1000;  // default 1 sec
        const minTimeout = 500;
        timer = setInterval(updateLog, Math.max(timeout, minTimeout));
    } else if (response.ok && jobStatus === 'finished' && timer) {
        console.debug('Clearing reload timer');
        clearInterval(timer);
        timer = null;
    }

}

document.addEventListener('DOMContentLoaded', updateLog, false);
