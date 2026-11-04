# Privacy

Project Manager has no server, no accounts, no analytics and no tracking. Its author receives nothing from it.

## What goes to OpenAI

The extension sends text to OpenAI (`api.openai.com`), using your key, in these cases:

- **When you capture a reply:** that reply, your message before it, the project's goal and out-of-scope rules, and its open commitments.
- **When a capture reviews open commitments:** excerpts of earlier captured replies.
- **When the new-project form opens:** an excerpt of the reply and the conversation's title, to pre-fill the form. This happens even if you then cancel.
- **On a conversation's first capture:** your projects' names, goals and out-of-scope rules with an excerpt of the conversation, to record a guess at which project it belongs to.
- **When you press Test key:** the word "ok".

OpenAI handles this under the terms of your own account. See [OpenAI's policies](https://openai.com/policies/).

## What stays in your browser

Your key, projects, goals, captured excerpts and results are kept in Chrome's local extension storage (`chrome.storage.local`).

**Your key is not encrypted there.** Anyone or anything with access to your Chrome profile on disk can read it. Consider setting a spending limit on your OpenAI account.

Exports you make from Options leave the key out, but they do contain your projects and captured text.

## Pages it reads

The extension runs only on chatgpt.com and claude.ai. It reads those pages to place its button and to find the reply you capture. Nothing leaves your browser until you press **Capture round**.

## Removing it

Removing the extension from `chrome://extensions` deletes its stored data. Text already sent to OpenAI is covered by OpenAI's terms, not by this. To stop further use of the key, delete it on the [API keys page](https://platform.openai.com/api-keys).

## Questions

[Open an issue](https://github.com/noamrosendev/project-manager-extension/issues).
