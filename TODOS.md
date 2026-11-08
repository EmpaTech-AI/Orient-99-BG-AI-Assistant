# TODOS

## Make scenarios (Messenger and Instagram)

### Instagram sends channel "messenger" and checks the wrong thread field

**What:** Make the "Orient 99 New Instagram AI" scenario send `channel: "instagram"` to `/chat` and use one thread-id field consistently for the `/start` versus `/chat` decision and for `/chat`.

**Why:** Every Instagram reply currently gets the Messenger rules (600 characters instead of 450, and the Messenger handoff path), and the route that decides between `/start` and `/chat` tests the Messenger thread-id field while `/chat` reads the Instagram one, so Instagram clients may lose context between messages.

**Pros:** correct length limits, handoff path and context on Instagram.

**Cons:** a live production change in Make, so it needs the engineer's yes and a test copy first.

**Context:** found on 2026-11-04 while patching route 1 of the Instagram scenario (route 1 is already patched and live). Start by exporting the blueprint and comparing the two thread fields (Messenger field vs Instagram field) in route 57 and in the `/chat` modules. ClickUp task 869fnmpyu, Sprint 3.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Offer catalog

### Scheduled weekly catalog refresh

**What:** A scheduled GitHub Action that runs `npm run catalog:refresh` and opens a pull request with the diff.

**Why:** The catalog should not depend on one person remembering a Monday run; today the only signal that it is old is a log line after 14 days.

**Pros:** no stale catalog after a missed week.

**Cons:** a CI job that sends several hundred requests a week to orient99.com from GitHub's network, and a token that can open pull requests.

**Context:** wait for 2 to 3 manual refreshes to see how stable the scraper and its guards are before automating. Design decision C5 chose a manual Monday run by the engineer. Spec: GitHub issue #2.

**Effort:** M
**Priority:** P3
**Depends on:** the catalog PR merged, and the refresh guard thresholds settled after the first full run

### Make the offer-drop guard compare like with like

**What:** Guard (b) of the refresh (refuse to write when offers drop more than 15%) should compare only offers that still have a future departure on both sides.

**Why:** In autumn, when summer programs end by design, guard (b) can trip legitimately and teach people to use `--accept-drop` by reflex, which would stop it protecting against a real failure.

**Pros:** the guard stays meaningful all year.

**Cons:** a second date comparison to write and test.

**Context:** revisit after the first autumn refresh shows how often guard (b) trips. Raised by the outside voice of the eng review of GitHub issue #2.

**Effort:** S
**Priority:** P3
**Depends on:** guard (b) shipping in the catalog PR

## Completed
