# Project Manager

A Chrome extension for long projects you run through ChatGPT or Claude. Press **Capture round** under a reply and it compares that reply with your project's goal and with what earlier replies promised. It reports when the conversation is repeating itself, has dropped a commitment or has drifted off goal.

It doesn't do the work and it won't suggest a direction. It only reports.

**This is an early release.** Accuracy has not been established, so treat a verdict as a prompt to look, not as a finding. The test server uses a small model, `gpt-4o-mini` by default, while the checks were built on `gpt-4o`. Accuracy on the small model is unmeasured. It runs on chatgpt.com and claude.ai, and has been tested in desktop Chrome only.

## Install

1. Download `project-manager-*.zip` from the [latest release](https://github.com/noamrosendev/project-manager-extension/releases/latest) and unzip it somewhere you'll keep it.
2. Open `chrome://extensions` and turn on **Developer mode**, top right.
3. Click **Load unpacked** and choose the unzipped folder.

Keep the folder where it is. Chrome treats a folder at a different path as a different extension, with none of your projects in it.

**To update:** replace the files inside that same folder, then click the reload icon on the extension's card in `chrome://extensions`.

## Add your access code

During this test you don't need an OpenAI account, and captures cost you nothing. The extension opens a screen when it's installed, and Options links back to it. Paste the code you were given and press **Test code**.

Codes are given out by hand. Each has a limit of rounds per day and of dollars per month, and the whole test has a monthly budget. When one runs out, captures are refused and the message says which. If it's a monthly limit or the budget, please tell the author through the link in the message.

## First use

Open a conversation on chatgpt.com or claude.ai and press **Capture round** under the latest reply. A round is one reply you capture, checked against your goal and your earlier rounds. Press it when a piece of work is done or a decision is made, not under every reply. The first capture in a conversation asks which project it belongs to, or lets you name a new one with its goal. Press the verdict to see the panel, which says what the verdict means.

Nothing is captured until you press the button.

## Known limits

- It sees only the replies you capture, so work you do elsewhere is invisible to it.
- A long message that claude.ai turns into a pasted attachment can't be read. The panel says so when this happens. On ChatGPT the panel says only that your message couldn't be read.
- A change to either site's page can stop the extension reading it.

## What it can access

Chrome lists these when you install. Each is here for one reason, and this list is checked against the extension's manifest whenever it's built.

**Sites**

- `https://chatgpt.com/*` and `https://claude.ai/*`: read and change these pages, so it can add the **Capture round** button and read the reply you capture. Its script runs on every page of these two sites. These two sites can also tell the extension is installed, because it makes three of its files available to them to draw the panel.
- `https://pm-proxy.noamros13.workers.dev/*`: the test server. This is the only place it sends anything. It carries your captures to OpenAI, and checks your access code.

It has no access to any other site, and it can't contact OpenAI or any other model API directly. All of that goes through the test server.

**Browser features**

- `storage`: keeps your code, projects and results in this browser.
- `unlimitedStorage`: lets long projects grow past Chrome's default storage limit. It's still only this browser.
- `scripting`: adds the button to chat tabs that were already open when the extension was installed or updated, and shows an error message on the page.
- `contextMenus`: adds **Capture selection as a Project Manager round** to the right-click menu on the two chat sites.
- `notifications`: shows a desktop notification if a capture error can't be shown on the page. It's used for nothing else.

## Privacy

See [PRIVACY.md](PRIVACY.md). In short, what you capture goes to OpenAI through a server we run, which stores none of it and keeps only counts. Your projects stay in your browser.

The counts are deleted by the author running a command when the test ends, no later than 31 January 2027. It isn't automatic.

## Feedback

[Open an issue](https://github.com/noamrosendev/project-manager-extension/issues) (needs a free GitHub account). Please don't paste your code or private conversation text into it, because issues are public.

## Licence

Free to use. All rights reserved.

## This repository

This is the extension as shipped, built from a private working repository, plus the test server's code in `worker`. The tests aren't here because their fixtures hold real conversation text.
