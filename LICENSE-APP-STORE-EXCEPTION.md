# FlowMic — App Store Distribution Exception

Additional permission under GNU Affero General Public License version 3
section 7.

**In force since 2026-08-19.** The copyright holder named throughout this
document is **FlowMic (flowmic.app)** — the public project name of the
individual rights holder, **Baojun-Han**, the same person and the same name
used in [LICENSE](LICENSE), [packages/protocol/LICENSE](packages/protocol/LICENSE)
and [CLA.md](CLA.md). Questions go to
[github@flowmic.app](mailto:github@flowmic.app).

If you modify this Program, or any covered work, this exception does not
apply to your modified version unless you are FlowMic (flowmic.app) or acting
with FlowMic (flowmic.app)'s prior written authorization to distribute it
under this exception.

## Why this document exists

AGPL-3.0 sections 4, 6 and 7 require that everyone who receives the Program
receives the full right to run, modify and convey it, with no further
restrictions attached. App store terms routinely attach exactly such
restrictions — per-device install limits, a ban on passing the installed
binary to anyone else, and the store's own usage rules. Those terms and the
AGPL conflict unless the copyright holder grants an additional permission
under section 7 that lets that one distribution channel exist.

This document is that permission, and it is deliberately narrow: it covers
official builds that we publish ourselves, and nothing else.

## The permission

As the copyright holder of FlowMic, FlowMic (flowmic.app) grants you the
following additional permission, notwithstanding any other provision of the
GNU Affero General Public License version 3 ("the License"):

When FlowMic (flowmic.app) itself distributes an official build of FlowMic
through a Store — meaning a digital distribution platform operated by a third
party under whose terms of service such a build is made available to end
users, including but not limited to Apple's App Store, Google's Play Store,
and Microsoft's Microsoft Store — FlowMic (flowmic.app) is permitted to accept
and comply with that Store's additional terms of service governing the
installation, use, and redistribution of that specific build, even where
those terms would otherwise conflict with, or impose restrictions beyond,
Sections 4, 6, and 7 of the License, PROVIDED THAT:

1. **Source availability is unaffected.** The Corresponding Source for the
   exact version distributed through the Store remains available to everyone,
   free of charge, under the ordinary terms of the License, from FlowMic's
   public source repository — a Store's restriction on redistributing the
   *binary* obtained through it does not extend to the source.

2. **This exception is scoped to FlowMic (flowmic.app)'s own distribution.**
   It applies only to builds that FlowMic (flowmic.app) itself publishes
   through an official Store listing under its own developer account, or
   through an account it has specifically and in writing authorized for that
   purpose. It does not authorize any other person or organization to invoke
   this exception for their own Store submission of FlowMic or a modified
   version of it — see the notice at the top of this file.

3. **Every other channel keeps full AGPL rights.** Nothing in this exception
   reduces the rights of anyone who obtains FlowMic through any channel other
   than an official Store distribution covered by this exception — building
   it from source, receiving it from FlowMic (flowmic.app) or a third party
   outside a Store, or any other means of conveying under the License. Those
   recipients continue to receive the full rights the License grants,
   including the right to redistribute, modify, and convey modified versions
   under the License's ordinary terms.

4. **This is an addition, not a replacement.** Every other term of the
   License continues to apply to FlowMic in full. This exception only
   suspends the specific conflict between a Store's terms and Sections 4/6/7
   for the narrow case described above; it does not waive copyleft, does not
   grant sublicensing rights to third parties, and does not affect the
   License's patent grant or warranty disclaimer.

If any Store's terms would require a broader permission than the one granted
above in order for FlowMic (flowmic.app) to distribute FlowMic through it,
that distribution is not covered by this exception until this document is
updated to say so.

## Scope notes

- **`packages/protocol` is not affected.** It is
  [Apache-2.0](packages/protocol/LICENSE), which has no conflict with store
  terms, so it needs no exception.
- **This permission is why contributions require a CLA.** The grant above can
  only be made for code whose copyright we hold; see
  [CONTRIBUTING.md](CONTRIBUTING.md) and [CLA.md](CLA.md#why-flowmic-asks-for-this).
- **This text is not lawyer-drafted.** It follows the structure and wording
  conventions of section 7 additional permissions as commonly published by
  other AGPL/GPL projects. The reasoning behind each clause, and what was
  deliberately left out, is recorded in
  `docs/strategy/2026-08-04-l1-l3-license-drafts-for-owner.md` §4 (private
  repository).
