# iOS Shortcuts

The iPhone side is intentionally user-triggered. These Shortcuts do not poll the
clipboard or run a background clipboard monitor.

## Before building the Shortcuts

Create a dedicated API device credential on the server:

```bash
docker compose exec api node dist/cli/create-device.js --name "Diogo iPhone"
```

Collect these values:

- API URL, for example `https://clipboard.example.com`
- the iPhone's Clipboard Mate device token
- if Cloudflare Access protects the hostname, its service-token client ID and
  client secret

The steps below use `CM URL`, `CM Token`, `CF Client ID`, and `CF Client Secret`
as named variables. The simplest setup is one **Text** action followed by **Set
Variable** for each value at the start of a Shortcut. Anyone who can inspect or
export that Shortcut can recover embedded credentials, so keep it private. Do
not publish an iCloud Shortcut link containing real credentials.

Every request needs this application header:

```text
Authorization: Bearer <CM Token>
```

When Cloudflare Access is enabled, add both edge-authentication headers too:

```text
CF-Access-Client-Id: <CF Client ID>
CF-Access-Client-Secret: <CF Client Secret>
```

Header names are case-insensitive. Do not put secrets in the URL.

## Shortcut 1: Publish Clipboard

Create a Shortcut named **Clipboard Mate: Publish** with these actions in order:

1. **Get Clipboard**.
2. **Get Text from Input**, using the Clipboard result. This keeps the API
   text-only; stop with an alert if the clipboard cannot produce text.
3. **Generate UUID**. Keep its magic variable as `Mutation ID`.
4. **URL**: `CM URL` followed by `/v1/shortcut/push`.
5. **Get Contents of URL** with:
   - method: `POST`;
   - header `Authorization`: `Bearer ` followed immediately by `CM Token`;
   - optional headers `CF-Access-Client-Id` and
     `CF-Access-Client-Secret` using the two Access variables;
   - request body: `JSON`;
   - JSON key `mutationId` (Text): the `Mutation ID` magic variable;
   - JSON key `text` (Text): the output from **Get Text from Input**.
6. **Show Notification** with `Published to Clipboard Mate`.

The endpoint returns HTTP 204 on success, so an empty action result is normal.
The UUID makes a retried request idempotent. Generate a new UUID for every new
button invocation; do not store and reuse one for later clipboard values.

To publish selected text from other apps as well, enable **Show in Share Sheet**
for Text input. At the beginning, use **If** `Shortcut Input` has any value:
choose **Get Text from Input** from `Shortcut Input`; otherwise use **Get
Clipboard**. The remaining publish steps are unchanged and still require a
deliberate invocation.

## Shortcut 2: Pull Latest (simple)

This short version is sufficient if you treat empty text and a cleared shared
state the same way:

1. **URL**: `CM URL` followed by `/v1/shortcut/latest`.
2. **Get Contents of URL** with method `GET` and the same Authorization and
   optional Cloudflare Access headers.
3. **If** the URL Contents has any value:
   - **Copy to Clipboard** using URL Contents;
   - **Show Notification** with `Copied from Clipboard Mate`.
4. **Otherwise**, show `Clipboard Mate is cleared` and leave the local
   clipboard untouched.

The endpoint returns plain UTF-8 text, so there is no JSON extraction step.

## Cleared state versus valid empty text

These are deliberately different server states:

- explicitly cleared: `GET /v1/shortcut/latest` returns HTTP **204**;
- published empty string: it returns HTTP **200** with a zero-byte body.

The standard **Get Contents of URL** output does not reliably expose that status
distinction to subsequent Shortcuts actions; both can appear as “no value.” If
you need exact behavior, build the strict pull below instead of inferring state
from the plain-text response body.

## Shortcut 2 alternative: Pull Latest (strict)

This version preserves the distinction and can intentionally copy an empty
string (which normally clears the local clipboard):

1. **URL**: `CM URL` followed by `/v1/state`.
2. **Get Contents of URL** with method `GET` and the same authentication
   headers. Its output is a JSON dictionary.
3. **Get Dictionary Value** for key `value` from URL Contents. Name it `Shared
   Value`.
4. **If** `Shared Value` has any value (it is a dictionary):
   - **Get Dictionary Value** for key `content` from `Shared Value`;
   - **Copy to Clipboard** using that content;
   - **Show Notification** with `Copied revision` followed by the top-level
     `revision` value if desired.
5. **Otherwise** (`value` is JSON `null`), show `Clipboard Mate is cleared` and
   leave the local clipboard untouched.

Check the `Shared Value` dictionary, not its `content` field, in the **If**
condition. A valid empty-string revision still has a non-null value dictionary
with origin and timestamp fields.

## Practical placement

Both Shortcuts can be launched from the Shortcuts widget, Control Center, Siri,
the Action Button, or a Home Screen icon. Keep publish and pull separate so each
invocation has one obvious direction and cannot accidentally overwrite either
clipboard.

If a request fails, Shortcuts surfaces the HTTP error and does not proceed to
the success notification. Check the API health, the three credential headers,
and whether the device ID has been revoked. The API deliberately does not accept
credentials in query parameters.

Apple's current action model is documented in the
[Shortcuts User Guide](https://support.apple.com/guide/shortcuts/welcome-apda2b83d0e0/ios).
