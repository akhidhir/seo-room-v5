# Action Plan → Control Centre — Spec

## What it is
A job board for the team. It does **not** re-list or re-fix issues — diagnosis stays on the audit pages, fixing stays in place. The Control Centre adds the missing layer: **who owns each issue, by when, and how it's tracked** across every client. The team lead watches one screen.

Three labels run the whole thing:
- **Code** = which issue it is (a name tag, never changes)
- **Fix type** = what skill it needs (decides which tool opens)
- **Assignee** = who's doing it

---

## 1. The Ticket
Every real issue becomes one ticket, automatically. A ticket has:

| Field | Example | Notes |
|---|---|---|
| Code | `PRJ-INDX-01` | Permanent. Never changes. |
| Project | Projection Plumbing | |
| Root cause | Thin content blocking indexing | One cause, even if it has many symptoms |
| Affected items | /plumber-warner/, /plumber-bunya/ | The pages/items under this cause |
| Fix type | Copywriting | Set automatically from the issue category |
| Assignee | Sarah | Inherited from the project, or set per ticket |
| Status | In Progress | Moves through a lifecycle (below) |
| Due date | Thu | Shows on the assignee's calendar |
| Est. hours | 1.5 | For capacity/workload |

---

## 2. Code scheme
Format: `PRJ-PILLAR-NN`

- **PRJ** — 3-letter project code (registry, one per project): Projection Plumbing = `PRJ`, Car Key Rescue = `CKR`, etc.
- **PILLAR** — short root-cause area: `INDX` indexing, `CWV` speed, `CONT` content/thin, `CITE` citations, `LINK` links, `CANB` cannibalization, `GBP`, `TECH`, etc.
- **NN** — sequence within that project + pillar (`01`, `02`, …)

The code is **stable for life**. When work moves to the copywriter it does NOT become a new code — same `PRJ-INDX-01`, just a new **status**.

---

## 3. Fix type → which tool opens
The ticket is the front door; clicking it drops the right person into the right existing tool, pre-loaded.

| Fix type | Opens | Set when issue is… |
|---|---|---|
| Copywriting | Copywriter editor (page pre-loaded) | thin content, meta, low CTR, suburb pages |
| Technical | Audit page with the green "Fix" button | schema, canonical, noindex, CWV |
| GBP | GBP task / action steps | citations, NAP, photos, reviews |
| Manual | Short checklist with instructions | anything needing a human off-platform |

Fix type is **derived automatically** from the issue category — nobody types it in. It's also a filter ("show all Copywriting tickets").

---

## 4. Status lifecycle
Minimal and linear, with a review loop:

`New → Assigned → In Progress → Ready for Review → Done`

Status moves should feel automatic, not like extra admin:
- **Auto "In Progress":** the moment Sarah opens the ticket and lands in the tool, it flips to **In Progress** on its own. She never has to set it.
- **Finish button:** when she's done she clicks **Finish** → ticket goes to **Ready for Review** (or straight to **Done** if review isn't required for that fix type).
- **Reopened** sends a ticket from Review back to In Progress (same code).
- Optional **Blocked** flag for waiting-on-client.

So Sarah's only manual action is clicking **Finish**. Starting is automatic.

---

## 5. Auto-population + root-cause grouping
- Issues land in the Control Centre **on their own** — nothing is manually "sent."
- **One ticket per root cause, not per symptom.** 148 Core Web Vitals warnings = **one** ticket (`PRJ-CWV-01`) with 148 affected pages attached — not 148 tickets. This is what stops the list exploding to 500 items.
- A background step clusters raw findings into root-cause tickets and de-duplicates by code (so re-running an audit updates the same ticket instead of creating new ones).

---

## 6. Assignment
- **Default: by project.** Assign Projection Plumbing → Sarah once, and every ticket for that client is hers.
- **Exception: by ticket.** Occasionally grab one ticket and give it to someone else (overrides the project default for that ticket only).
- **Reassign anytime.** If Sarah's off, reassign the project (or a single ticket) to someone else — their calendar updates automatically.
- **Roles:** Lead sees everything; Member sees only their own tickets.

---

## 7. Timeline, lateness & daily distribution

### Calendar (the member's view)
- Each ticket has a scheduled day + due date → shows on the assignee's calendar.
- Member opens their calendar, clicks a ticket, lands in the right tool (auto "In Progress"), fixes it, clicks Finish.

### Late / on-time
- Each ticket carries a **due date**. If today is past the due date and the ticket isn't Done → it's flagged **Late** (red) on the member's calendar and the lead's board.
- On-time = Done on or before its scheduled day.

### Daily distribution (driven by project hours)
This is the scheduler that fills the calendar:
- Each project has a **monthly hours** allocation in **Project Settings**.
- The system converts that to a **daily budget** = monthly hours ÷ working days in the month.
- It fills each working day with tickets **in priority order** (below) until that day's `estimated_hours` budget is full, then moves to the next day.
- Result: every day a member opens their calendar and sees a realistic, hours-balanced set of the *most important* tasks — not a 300-item pile.
- If a day's work isn't finished, the leftover rolls to the next day and (if past due) shows Late.

### What gets scheduled first (priority + quick wins)
Tickets are ordered by **value-per-hour = impact ÷ effort**, so two things rise to the top naturally:
1. **High priority** — critical/high severity and ranking-driven items (a keyword stuck at position 6, a not-indexed money page) carry high impact.
2. **Quick wins** — high impact *and* low effort (e.g., GSC positions 4–20, a meta tweak, a schema fix). Because effort is small, their value-per-hour is high, so they get done early without crowding out the day.

Simple rule: **do the cheap, high-impact things first; then the big important things; small low-impact things last.** Critical items never get buried under busywork, and the team banks fast results early.

Example: Projection Plumbing = 10 hrs/month ≈ 0.5 hr/working day → each day the scheduler drops ~half an hour of the highest value-per-hour tickets onto Sarah's calendar, quick wins first, and stops once the daily budget is full.

**Capacity (per member):** sum of each member's daily budgets across all their projects, so the lead can see if anyone is over-allocated.

---

## 8. Control Centre (the lead's view)
One screen, switchable:
- **By member** — workload + overdue
- **By project** — client health rollup
- **By status** — where the bottleneck is
- **This week** / **Overdue**
- **Client export** → feeds the Monthly Report (client-facing plan)

---

## 9. Reuse vs build
**Reuse (already exists):** audits/findings, fixing tools + copywriter editor, Team Members, and the `action_items` columns `assigned_to`, `scheduled_date`, `estimated_hours`.

**Build new:**
- Code generator + per-project code registry
- Root-cause grouping + de-dupe
- Fix-type routing to the right tool
- Normalized status lifecycle (fixes today's mixed-case mess)
- Assignment (project-level default + per-ticket override + reassign)
- Member calendar
- Lead Control Centre board

---

## 10. Build order
**Phase 1 — make the data sane + a real board**
1. Normalize severity + category labels (kill `High`/`high`, `Quick Wins`/`Quick Win` duplicates).
2. Add `code`, `fix_type`, `root_cause_key` to tickets; group findings into root-cause tickets.
3. Project-level assignment + member list view + status moves.
4. Lead board (by member / by project / by status).

**Phase 2 — scheduling**
5. Add **monthly hours** field per project (Project Settings) if not already there.
6. Daily distribution engine (project hours → daily budget → spread tickets across days).
7. Member calendar + due dates + auto "In Progress" on open + Finish button + Late flag + per-ticket reassign + capacity.

**Phase 3 — polish**
6. Notifications, client export → Monthly Report, change history (who moved what, when).

---

## 11. Decisions still needed
1. The 3-letter **project codes** (one per client).
2. The exact **pillar code list** (INDX, CWV, CONT, …).
3. Confirm **native build** (lean) vs pushing tickets to an external PM tool — recommendation: native and lean.
