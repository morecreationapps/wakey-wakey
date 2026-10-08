# Preparation task autofill revision — 8 October 2026

Recognised titles and idea buttons already called the suggestion engine. The strict general scheduler could refuse every slot when the preceding rota day, personal wake times or confirmation flags were incomplete. Its empty combined date/time value also hid the known preceding calendar date.

## Resulting behaviour

- New preparation drafts expose the preparation date separately from the start time. The date is the selected shift's preceding calendar day and follows the chosen display format.
- Recognised titles and idea buttons share task-specific draft defaults. Suggestions remain editable, deliberately changed or cleared fields are protected, and unrelated optional fields stay blank.
- Preparation-only calculations can show explicitly provisional suggestions from existing positive settings and recorded commitments. They do not change saved settings, assert unknown rota availability as fact, or change Shift Plan.
- A missing personal late-shift wake preference is still a real missing input. The date and duration remain visible; the interface names the missing information rather than guessing a clock time.
- Saved preparation rows keep chosen times, flag conflicts, and sort chronologically. Existing fixed bookings stay fixed.
- The panel label is Shift Transition. Its empty state directs the user to choose an idea or add a task.

## Verification

The full automated suite passed: 572 tests across 15 files. TypeScript and the production web export passed. Deployment identifiers and live checks are recorded in the local release-check report. Synthetic browser examples are isolated from authentication, persistence and the live account. No test tasks are saved into the live account.
