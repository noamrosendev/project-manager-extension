# Privacy

During this test, what you capture is sent to OpenAI through a server we run. That server stores none of it. It keeps only the counts listed below.

Your projects stay in your browser. There are no accounts and no analytics.

## What is sent

Nothing leaves your browser until you press a button.

- **When you press Capture round:** that reply, your message before it, the project's goal and out-of-scope rules, and its open commitments.
- **When a capture reviews open commitments:** excerpts of earlier captured replies.
- **When you press Draft goal from this reply:** an excerpt of the reply and the conversation's title. Opening the form sends nothing.
- **When you press Test code:** only your code. It goes to our server and no further.

Everything except Test code goes to our server and on to OpenAI. Your access code goes with each request to our server. It is not passed to OpenAI.

## Our server

It is a Cloudflare Worker. Its code is in the `worker` folder of this repository, and it holds our OpenAI key, which never reaches your browser.

It does not log or store request or response bodies. It has no logging statements, and Cloudflare's Workers logging is turned off in its configuration.

Cloudflare runs the network and the machines it passes through, so your text passes through Cloudflare. Cloudflare's own handling of traffic is covered by [its privacy policy](https://www.cloudflare.com/privacypolicy/), not by this statement.

## Exactly what is counted

Per access code:

| Count | What it is |
|---|---|
| `code` | your access code |
| `label` | a note we wrote when we gave you the code, such as who it is for |
| `rounds_used` | rounds, all time |
| `tokens_used` | OpenAI tokens used, all time |
| `daily_count` | rounds on the last day you used it |
| `daily_calls` | model calls on the last day you used it |
| `last_reset` | the date of that day (UTC) |
| `month_microusd` | what your code has cost this month, in millionths of a dollar |
| `month_key` | the month that figure is for (UTC) |
| `enabled` | whether the code works |

Per month, across everyone: the total spent in dollars, the total tokens used, and when the budget alert was sent, if it was.

So we can see how much each code was used, and on which most recent day. We can't see what was captured. No conversation text, project names, goals, page addresses or titles are counted. 

**All of these counts are deleted when the test ends, and no later than 31 January 2027.** The author does this by running a command, so it isn't automatic.

## OpenAI

Our server tells OpenAI not to store requests for later use (`store: false`). OpenAI still says it keeps API content for up to 30 days to monitor for abuse, and we can't change that. These requests come from our OpenAI account, not yours. See [how OpenAI handles API data](https://developers.openai.com/api/docs/guides/your-data).

## What stays in your browser

Your code, projects, goals, captured excerpts and results are kept in Chrome's local extension storage (`chrome.storage.local`).

**They aren't encrypted there.** Anyone or anything with access to your Chrome profile on disk can read them.

Exports you make from Options leave the code out, but they do contain your projects and captured text.

## Pages it reads

The extension runs only on chatgpt.com and claude.ai. It reads those pages to place its button and to find the reply you capture.

## Removing it

Removing the extension from `chrome://extensions` deletes what is stored in your browser. It doesn't delete the counts on our server.

## Questions

[Open an issue](https://github.com/noamrosendev/project-manager-extension/issues).
