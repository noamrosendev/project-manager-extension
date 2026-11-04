// The first-run screen: the key, and nothing else. Projects start at first capture.
const $ = id => document.getElementById(id);
const status = (text, kind) => { $("keyStatus").textContent = text; $("keyStatus").className = `hint ${kind || ""}`; };

$("testKey").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  $("done").hidden = true;
  if (!apiKey) return status("Paste your key first.", "bad");
  await chrome.storage.local.set({ apiKey });
  status("Testing…");
  const res = await chrome.runtime.sendMessage({ type: "testKey" });
  // The failure wording points at Options, which is this field here.
  status(res?.ok ? "Key works and the account has credit." : String(res?.error || "The test didn't finish. Try again.").replace(/ Check it in Options\.$/, " Check it and try again."), res?.ok ? "ok" : "bad");
  $("done").hidden = !res?.ok;
});
