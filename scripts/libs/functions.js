
export let localize = key => {
    return game.i18n.localize(key);
};

export function loadScript(url, callback) {
    let script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = url;
    script.onload = callback;
    document.head.appendChild(script);
}

export function isModuleActive(modulename) {
    return game.modules.get(modulename)
        && game.modules.get(modulename).active;
}
/** Convert selected journal HTML into speech while retaining paragraph breaks. */
export function speechText(content) {
    const html = String(content).replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, "$&\n");
    const document = new DOMParser().parseFromString(html, "text/html");
    document.querySelectorAll("script, style").forEach(element => element.remove());
    return document.body.textContent.replace(/\u00a0/g, " ").trim();
}
