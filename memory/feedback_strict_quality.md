---
name: Don't ship shortcuts I'm already aware of
description: When I flag my own design as suboptimal during implementation, fix it in the same commit rather than punt for review
type: feedback
---

When I notice myself taking a "good enough for now" shortcut and would flag it as questionable in review, **fix it in the current commit** rather than ship it and surface it later.

**Why:** In the MindForest v2 refactor I shipped storage-fs with four design decisions I myself recognized as suboptimal at write-time (CJK→untitled slugifier, no rename on title change, _topic.md doubling as root node, no watcher self-write suppression). When I surfaced them in review the user pushed back on all four and asked me to hold a higher bar going forward. Knowingly cutting corners — even when transparently flagged — erodes trust, multiplies review cycles, and wastes context on rework.

**How to apply:** During implementation, if a design choice prompts an internal "I should mention this caveat" or "I'll flag it for them to decide," that's the signal to do the work properly NOW. Exceptions: a real blocker (missing dependency I'd have to introduce in a separate task, scope creep into a different task's responsibility), or when the proper fix would require user input I genuinely don't have. Otherwise the answer is to spend the extra minutes/lines and ship the right thing the first time. Keep "self-flagged shortcuts" out of review.
