# Project Manager test proxy

A Cloudflare Worker. It checks an access code and the caps, calls OpenAI with a key held as a Worker secret, and records counts. It never logs or stores a request or response body.

## Deploy into the existing Cloudflare account

The account already runs another project. These steps create and touch only a Worker called `pm-proxy` and a D1 database called `pm-proxy`. `wrangler.toml` sets no route and no custom domain, so no hostname the other project uses can be affected. Don't add one.

Run every command in this folder, because that is what points Wrangler at this Worker rather than the other project's.

### 1. OpenAI, first

The key is `manager-test`. Its project is the second ceiling, independent of the Worker's caps.

1. On the API keys page, check which project `manager-test` is in. It should be a project used for nothing else. If it isn't, create that project, create a new key there, and revoke this one.
2. In that project, open **Project settings > Limits > Spend**, turn on **Enforce a hard limit**, and set the monthly limit to **$60**. An alert alone doesn't stop anything. At $60 the Worker's clear refusal at $50 normally comes first, rather than OpenAI's error, which testers would see as "OpenAI is busy".
3. In the same limits, allow only the model in `wrangler.toml`, if that option is offered.
4. Check that auto-reload is off in billing.

Treat this limit as a backstop that may not fire. OpenAI says enforcement isn't instant, and there are reports of project limits not being enforced. The Worker's caps are the ceiling to rely on.

### 2. Sign in and choose the account

```
npx wrangler whoami
```

If it isn't signed in, run `npx wrangler login`. If it lists more than one account, choose this one for the session:

```
export CLOUDFLARE_ACCOUNT_ID=<the account's id>
```

### 3. Check the names are free

```
npx wrangler deployments list --name pm-proxy   # should say the Worker doesn't exist
npx wrangler d1 list                            # should not list pm-proxy
```

If either exists, **stop**. Deploying with a name already in use replaces that Worker. Change `name` and `database_name` in `wrangler.toml`, and use the new names in the commands below.

### 4. Create the database

```
npx wrangler d1 create pm-proxy
```

Put the `database_id` it prints into `wrangler.toml`. Check it is the id of the new database, not the other project's. Then:

```
npx wrangler d1 execute pm-proxy --remote --file schema.sql
```

If this database was created before the per-code cap existed, add its columns once:

```
npx wrangler d1 execute pm-proxy --remote --command "ALTER TABLE codes ADD COLUMN month_key TEXT NOT NULL DEFAULT ''; ALTER TABLE codes ADD COLUMN month_microusd INTEGER NOT NULL DEFAULT 0;"
```

### 5. Set the secrets

Each command prompts for its value. Paste it there, never into a file or a chat.

```
npx wrangler secret put OPENAI_API_KEY   # the manager-test key
npx wrangler secret put STATUS_TOKEN     # any long random string
```

If the Worker doesn't exist yet, Wrangler offers to create it. Answer yes, after checking the name it shows is `pm-proxy`.

### 6. Deploy

```
npx wrangler deploy
```

It prints the address, `https://pm-proxy.<subdomain>.workers.dev`. The subdomain belongs to the whole account, and this address goes into the public extension's manifest.

### 7. Check it is separate and off

The Worker starts switched off. Before going further:

```
curl -H "X-Status-Token: <token>" https://<worker>/v1/status    # "paused":true, spent_usd 0
curl -H "X-Access-Code: anything-here" https://<worker>/v1/check   # refuses: the test is paused
npx wrangler deployments list --name <the other project's Worker>  # its latest deployment is unchanged
```

### 8. Add a code and turn it on

Add a code as below, then:

```
npx wrangler d1 execute pm-proxy --remote --command "UPDATE settings SET value='0' WHERE key='kill_switch'"
curl -H "X-Access-Code: <code>" https://<worker>/v1/check       # "ok":true, and no call to OpenAI
```

### 9. Build the extension

```
PM_PROXY_URL=https://<worker> PM_COUNTS_DELETE_BY=2027-01-31 node ../scripts/build_public.mjs <out dir> <zip dir>
```

Make one real capture. Then check that `/v1/status` shows some spend, and that the usage appears under the OpenAI project.

### Removing it

These touch nothing else in the account:

```
npx wrangler delete pm-proxy
npx wrangler d1 delete pm-proxy
```

## Add a code

Codes are inserted by hand. 6 to 128 letters, digits, `-` or `_`. Make them long and random.

```
npx wrangler d1 execute pm-proxy --remote --command "INSERT INTO codes (code, label) VALUES ('<code>', '<who it is for>')"
```

Disable one with `UPDATE codes SET enabled=0 WHERE code='<code>'`.

## Kill switch

Stops everything, immediately, for every code:

```
npx wrangler d1 execute pm-proxy --remote --command "UPDATE settings SET value='1' WHERE key='kill_switch'"
```

## Caps

All in `[vars]` in `wrangler.toml`. A value that isn't a positive whole number stops the Worker.

- `ROUNDS_PER_DAY`: rounds per code per UTC day. A round is a capture's main call.
- `CALLS_PER_DAY`: every model call per code per UTC day. The hard ceiling, since the extension is what says which call is a round.
- `PER_CODE_MONTHLY_USD`: dollars per code per UTC month, reserved the same way. Thirty codes at $2 is $60, so the global $50 cuts in first. Each extra code adds to that sum, and the global budget still holds.
- `FEEDBACK_URL`: where a tester is sent when the budget or their code's dollars run out. Must be an https address, or the Worker refuses everything. Check that this address's notifications reach you, since a tester's message may be how you first hear the money has run out.
- `MONTHLY_BUDGET_USD`: dollars across all codes per UTC month. Each call's worst case at the configured prices is reserved before it is sent, then settled to its real cost.
- `PRICE_INPUT_PER_M`, `PRICE_OUTPUT_PER_M`: dollars per million tokens. Change them whenever `MODEL` changes, because a wrong price makes the budget wrong.
- `MAX_OUTPUT_TOKENS`, `MAX_BODY_BYTES`: the most one call can use.
- `MODEL`: the model. Whatever the extension asks for is ignored. Your own build uses `DEFAULT_MODEL` in `lib/core.js`, and the two must match, so reports from either can be read the same way. Change `MODEL`, both prices and `DEFAULT_MODEL` together, deploy the Worker and reload your extension at the same time. The public build refuses to run if they differ.

## Status

Spend and what remains this month, with nothing per code:

```
curl -H "X-Status-Token: <token>" https://<worker>/v1/status
```

With no token set, or the wrong one, it answers 404.

## Budget alert (optional)

An email when the budget is reached. It needs Cloudflare Email Routing on a domain: uncomment `[[send_email]]` in `wrangler.toml`, and set `ALERT_FROM` and `ALERT_TO` as secrets. The caps hold without it, and a failed email changes nothing. The status page says whether it is set up.

## Counts

To see them: `SELECT label, rounds_used, tokens_used, daily_count, last_reset, month_key, month_microusd FROM codes`.

## Deleting the counts

`PRIVACY.md` promises the counts are deleted when the test ends, no later than 31 January 2027, the date given to the build as `PM_COUNTS_DELETE_BY`. This is not automatic. Someone has to run this:

```
npx wrangler d1 execute pm-proxy --remote --command "DELETE FROM codes; DELETE FROM budget;"
```

## Test

`npm install && npm test`. Real workerd and D1, with OpenAI faked at the network boundary.
