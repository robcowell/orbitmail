# Security policy

Orbit Mail reads mail from strangers, holds your mail passwords and OAuth tokens,
and can send your mail to Anthropic if you turn the AI features on. If you have
found a way any of that can be abused, I want to hear about it privately first.

## Reporting a vulnerability

**Please do not open a public issue.**

Report it through GitHub's private vulnerability reporting: go to the
repository's **Security** tab and choose **Report a vulnerability**. Only the
maintainer can see the report, and we can work on the fix and the advisory
together there.

If you cannot use that, open an ordinary issue asking for a private contact —
with no details of the problem in it.

A useful report says which version you were running (the package you installed,
or the commit if you built it yourself), what an attacker has to control (a
message they send you, a server you connect to, something on your machine), and
what they get.

## What to expect

This is a one-person project, so responses are best effort rather than to a
deadline. I will acknowledge the report, tell you whether I can reproduce it,
and keep you updated until it is fixed. Once a fix is released the advisory is
published, with credit to you if you want it.

## Supported versions

Only the latest release gets security fixes. Older versions will not be
patched — the fix is to update.

## Scope

In scope is the desktop app in this repository, for example:

- an email that runs script, reaches the app's IPC bridge, or tricks the reader
  into showing fake app UI
- credentials or tokens leaking — to disk in the clear, to logs, to another
  account, or into a build
- the OAuth sign-in flow accepting a response it did not ask for
- an attachment opening or running without the warning it should get
- a mail server, or anyone between you and it, being able to downgrade the
  connection or read your password

Out of scope:

- **Bring-your-own OAuth credentials.** Orbit Mail ships no OAuth client and
  asks each user to register their own. That is the design; see
  [DEVELOPERS.md → Known limitations](DEVELOPERS.md#known-limitations).
- **Problems already written down.** [DEVELOPERS.md → Security
  posture](DEVELOPERS.md#security-posture) and [TODO.md](TODO.md) list known
  gaps as plainly as the fixes. If you think one is worse than it is described,
  that is worth a report.
- **Bugs in Electron, your mail provider, or Anthropic's API** — please report
  those upstream. If Orbit Mail makes one of them worse, or fails to take a fix
  it should have, that is in scope.
- Anything that needs an attacker who already controls your user account on the
  machine.
