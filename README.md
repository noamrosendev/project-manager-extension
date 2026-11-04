# Project Manager

A Chrome extension for long projects you run through ChatGPT or Claude. Press **Capture round** under a reply and it compares that reply with your project's goal and with what earlier replies promised. It reports when the conversation is repeating itself, has dropped a commitment or has drifted off goal.

It doesn't do the work and it won't suggest a direction. It only reports.

**This is an early release.** Accuracy has not been established, so treat a verdict as a prompt to look, not as a finding. It runs on chatgpt.com and claude.ai, and has been tested in desktop Chrome only.

## Install

1. Download `project-manager-*.zip` from the [latest release](https://github.com/noamrosendev/project-manager-extension/releases/latest) and unzip it somewhere you'll keep it.
2. Open `chrome://extensions` and turn on **Developer mode**, top right.
3. Click **Load unpacked** and choose the unzipped folder.

Keep the folder where it is. Chrome treats a folder at a different path as a different extension, with none of your projects in it.

**To update:** replace the files inside that same folder, then click the reload icon on the extension's card in `chrome://extensions`.

## Add your OpenAI key

The extension uses your own OpenAI account. It opens this screen when installed, and Options links back to it.

1. Sign in or create an account at [platform.openai.com](https://platform.openai.com/). This is separate from a ChatGPT subscription, which doesn't include it.
2. Add credit on the [billing page](https://platform.openai.com/settings/organization/billing/overview). $5 is plenty to start.
3. Create a secret key on the [API keys page](https://platform.openai.com/api-keys) and copy it.
4. Paste it into the extension's screen and press **Test key**. The test makes one very small call to OpenAI.

A captured round costs about 2 cents with gpt-4o. Each out-of-scope rule you add costs a little more per round.

## First use

Open a conversation on chatgpt.com or claude.ai and press **Capture round** under a reply. The first capture in a conversation asks which project it belongs to, or lets you name a new one with its goal. Press the verdict to see the panel.

Nothing is captured until you press the button.

## Known limits

- It sees only the replies you capture, so work you do elsewhere is invisible to it.
- A long message that claude.ai turns into a pasted attachment can't be read. The panel says so when this happens. On ChatGPT the panel says only that your message couldn't be read.
- A change to either site's page can stop the extension reading it.

## Privacy

See [PRIVACY.md](PRIVACY.md). In short, your data stays in your browser, except for what is sent to OpenAI with your key. There is no server of ours and no analytics.

## Feedback

[Open an issue](https://github.com/noamrosendev/project-manager-extension/issues) (needs a free GitHub account). Please don't paste your key or private conversation text into it, because issues are public.

## Licence

Free to use. All rights reserved.

## This repository

This is the extension as shipped, built from a private working repository. The tests aren't here because their fixtures hold real conversation text.
