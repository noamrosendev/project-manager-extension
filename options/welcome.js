// The first-run screen: the key, and nothing else. Projects start at first capture.
import { CREDENTIAL_KEY } from "../lib/build_flags.js";
const $ = id => document.getElementById(id);
const FEEDBACK_URL = "https://github.com/noamrosendev/project-manager-extension/issues";
const status = (text, kind) => {
  const node = $("keyStatus"), at = String(text).indexOf(FEEDBACK_URL);
  node.className = `hint ${kind || ""}`;
  if (at < 0) { node.textContent = text; return; }
  // Only this exact address becomes a link.
  const a = document.createElement("a");
  Object.assign(a, { href: FEEDBACK_URL, target: "_blank", rel: "noreferrer", textContent: FEEDBACK_URL });
  node.replaceChildren(text.slice(0, at), a, text.slice(at + FEEDBACK_URL.length));
};

$("testKey").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  $("done").hidden = true;
  if (!apiKey) return status("Paste your code first.", "bad");
  await chrome.storage.local.set({ [CREDENTIAL_KEY]: apiKey });
  status("Testing…");
  const res = await chrome.runtime.sendMessage({ type: "testKey" });
  // The failure wording points at Options, which is this field here.
  status(res?.ok ? "Code works." : String(res?.error || "The test didn't finish. Try again.").replace(/ Check it in Options\.$/, " Check it and try again."), res?.ok ? "ok" : "bad");
  $("done").hidden = !res?.ok;
});
