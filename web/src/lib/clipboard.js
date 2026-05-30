/**
 * Copy text to the clipboard, with a fallback for insecure (http://) contexts.
 *
 * `navigator.clipboard` only exists in a secure context (https or localhost), so
 * on a plain-HTTP deployment (e.g. http://host:8787) it is undefined and the
 * stock copy buttons silently do nothing. We fall back to the legacy
 * execCommand("copy") path in that case.
 *
 * @returns {Promise<boolean>} true if the copy succeeded.
 */
export async function copyText(text) {
  const s = String(text ?? "");
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
