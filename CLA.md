# FlowMic Individual Contributor License Agreement

**In force since 2026-08-14.** Written 2026-08-04, as part of closing the gap
between what [CONTRIBUTING.md](CONTRIBUTING.md) promises and what this
repository actually has wired up (card L2). The project owner filled in the
two open details on 2026-08-14: contributions are licensed to **Baojun-Han**
(the individual who holds FlowMic's copyright; "FlowMic (flowmic.app)" is the
project's public name for the same rights holder), and questions or signed
copies go to **github@flowmic.app**.

---

## Why FlowMic asks for this

FlowMic is [AGPL-3.0-only](LICENSE), with one carve-out: official builds we
publish through app stores carry an additional permission granting the rights
those stores' terms require, because store terms and the AGPL conflict
otherwise (see [README § License](README.md#license)). We can only grant that
additional permission for code we hold the copyright to. The first external
contribution merged without this agreement in place would permanently close
that option for the code it touches — there is no undoing it retroactively
without tracking down that contributor later and asking them to sign anyway.

This agreement does not take anything away from you. You keep your copyright.
You can license your own contribution to anyone else, under any terms you
like, at the same time. What it adds is a grant to us that is broad enough to
extend the App Store additional permission to your contribution too, and to
relicense the project as a whole later if that ever becomes necessary — for
example, the dual-licensing option described as "Option C" in
`docs/decisions/2026-08-02-open-source-license-agpl-vs-apache.md`, which that
document explicitly leaves open only on the condition that we hold clean
rights to 100% of the codebase.

If you would rather not sign this, you can still contribute: open an issue
describing the fix instead of a pull request, and we will credit you for it.
[CONTRIBUTING.md](CONTRIBUTING.md) says the same thing.

---

## 1. Definitions

**"You"** means the individual signing this agreement. If your employer has
rights to intellectual property you create, you represent that you have
received permission to make Contributions on behalf of that employer, or that
your employer has waived such rights, before you sign.

**"Contribution"** means any original work of authorship, including any
modification or addition to existing work, that you intentionally submit to
Baojun-Han for inclusion in FlowMic — through a pull request, patch,
or any other form of electronic, written, or verbal communication sent to
Baojun-Han or its representatives, including issue trackers and code
review systems, but excluding anything you conspicuously mark as
"Not a Contribution."

**"Project"** means the FlowMic software and its associated repositories,
whoever currently maintains them.

## 2. Grant of Copyright License

Subject to the terms of this agreement, You grant to Baojun-Han and
to recipients of software distributed by Baojun-Han a perpetual,
worldwide, non-exclusive, royalty-free, irrevocable copyright license to
reproduce, prepare derivative works of, publicly display, publicly perform,
sublicense, and distribute Your Contributions and such derivative works, **in
whole or in part, under any license terms Baojun-Han chooses,
including terms different from the AGPL-3.0 and including proprietary
terms.** This is the specific grant the App Store additional permission
depends on, and the grant Option C (a future commercial dual-license) would
depend on if Baojun-Han ever pursues it — both require that
Baojun-Han hold rights broad enough to license the combined codebase
on terms other than the AGPL for a specific distribution channel, without
needing to ask each contributor individually at that later date.

## 3. Grant of Patent License

Subject to the terms of this agreement, You grant to Baojun-Han and
to recipients of software distributed by Baojun-Han a perpetual,
worldwide, non-exclusive, royalty-free, irrevocable (except as stated in this
section) patent license to make, have made, use, offer to sell, sell, import,
and otherwise transfer Your Contribution, for those patent claims licensable
by You that are necessarily infringed by Your Contribution alone or by
combination of Your Contribution with the Project. If anyone institutes patent
litigation alleging that the Project or a Contribution incorporated within it
constitutes direct or contributory patent infringement, then any patent
licenses granted under this agreement to that entity for the Project
terminate as of the date such litigation is filed.

## 4. You keep your copyright

This agreement does not transfer ownership of Your Contribution to
Baojun-Han. You keep your copyright and may use, license, or
distribute Your own Contribution to anyone else, under any terms, including
terms incompatible with this agreement — the grants above are non-exclusive.

## 5. Representations

You represent that:

- each Contribution is either Your original creation, or You have sufficient
  rights to grant the licenses in this agreement for it (for example, because
  it is under a license compatible with these grants and you have complied
  with that license's requirements, and you say so when you submit it);
- to Your knowledge, each Contribution does not violate any third party's
  copyrights, trademarks, patents, or other intellectual property rights; and
- You are legally entitled to grant the licenses above — including, if your
  employer has rights to intellectual property You create, that You have
  received permission to make Contributions on behalf of that employer, or
  that Your employer has waived such rights.

If any of the above stops being true for a Contribution You have already
made, tell us — see §8.

## 6. No warranty

Unless required by applicable law or agreed to in writing, You provide Your
Contributions on an "AS IS" basis, without warranties or conditions of any
kind, either express or implied, including, without limitation, any
warranties or conditions of title, non-infringement, merchantability, or
fitness for a particular purpose.

## 7. This agreement is about rights, not obligations

Signing this agreement does not obligate You to provide support for Your
Contributions, except to the extent You choose to. Nor does it obligate
Baojun-Han to include any Contribution in the Project.

## 8. Keeping this current

Notify github@flowmic.app if anything in §5 stops being accurate, or if Your
legal name or contact information changes and You want the signature record
updated.

## 9. How to sign

Signing happens on your first pull request: an automated check comments on
the PR with a link to this document and asks you to reply with the sign
phrase it specifies. Signing once covers all your future contributions to
this repository. See `.github/workflows/cla.yml` for the mechanism — it is
described honestly there, including what has and has not been exercised yet
(this repository has no external contributors so far, so the check has never
actually run against a real signature).

If You would rather sign by email instead, write to github@flowmic.app with your
GitHub username, your name, and the sentence "I have read the FlowMic
Individual Contributor License Agreement dated 2026-08-04 and I agree to it,"
and we will record it manually.
