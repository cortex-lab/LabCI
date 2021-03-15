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

/**
 * Given some text and a class name, return the text wrapped in a span of that class.
 */
function toSpan(text, className) {
   return '<span class="' + className + '">' + text + '</span>';
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
    // const url = 'http://localhost:8080/log';
    const url = '/logs/raw/' + id;
    // If the console is empty, add some loading text
    if (!contentDiv.innerHTML) {
       contentDiv.innerHTML = 'Loading log....' + cursor;
    }

    // Fetch the remote log text
    console.debug('Reloading log');
    let log = await (await fetch(url)).text();

    // Apply the regex for styling/highlighting the text
    log = log.replace(/\x1b?\[0m/gm, '');  // Remove escape chars
    for (let style in regExps) {
       log = log.replace(regExps[style], x => toSpan(x, style));
    }

    // If not static, add a little blinking cursor to indicate activity
    if (urlParams.has('autoupdate')) {
       log += cursor;
    }

    // Check if you're at the bottom
    const elem = document.getElementById('console');
    const atBottom = elem.scrollHeight - elem.scrollTop === elem.clientHeight;

    // Update console text
    contentDiv.innerHTML = log;

    // If you were at the bottom, update scroll position
    if (atBottom) {
        elem.scrollTop = elem.scrollHeight;
    }
}
