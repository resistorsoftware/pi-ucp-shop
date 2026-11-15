---
description: Delegate a shopping research task to the pi agent (UCP catalog search, read-only)
---

Call the `pi_shop` tool exactly once, with `task` set to: $ARGUMENTS

`pi_shop` has already queried the live merchant catalog. Do not use grep, webfetch, bash or any
other tool to look for products — there is no local catalog data and no public catalog URL to fetch.
If `pi_shop` fails, report the error text and stop.

Present its result as a short ranked table (item, price, merchant, link), then say which one you
would pick and why.
