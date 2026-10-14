# Round 3 spec — 4 definitive candidates

Locked by Thomas, 2026-08-02:
- **R2-01 is the best layout.** Keep its skeleton exactly: task line on top, mode row
  under it, big numeral bottom-left, controls bottom-right, `···` top-right.
- **R2-01's colour and typography are rejected.** No gold `#c9b48a`. No Helvetica Neue.
- **R2-03 (Raycast) is the promising path.** Take its palette, its ink, its
  command-row interaction model.
- **Every menu, setting and screen lives INSIDE the notch.** Never a separate window.
  The notch may resize and reshape freely to fit.

## Locked design tokens (do not invent alternatives)

```
--canvas    #07080a   /* notch top, opaque, merges with the menu bar */
--surface   #0d0e12   /* lower notch body */
--raised    #16181d   /* rows, fields, pressed states */
--ink       #f4f4f6   /* primary text */
--ink-mid   #9ca1ab   /* secondary text, labels */
--ink-dim   #5f646d   /* placeholder, disabled */
--hairline  #1e2027   /* dividers, borders */
--focus     #f4f4f6   /* FOCUS accent = white. Deliberately achromatic. */
--break     #7fc06a   /* BREAK accent — the only hue in normal operation */
--done      #b9ea9c   /* completion bloom highlight (already shipped) */
```

Accent rule: focus mode carries **no hue at all** — state is shown by presence and
weight, not colour. Green appears only for break and completion. This is the direct
answer to "I don't like the colour".

## Typography

Native macOS stack, not Helvetica Neue:
```
font-family: -apple-system, "SF Pro Text", system-ui, sans-serif;
```
| Role | Size | Weight | Tracking |
|---|---|---|---|
| Numeral (expanded) | 38px | 300 | -0.03em |
| Numeral (pill) | 12.5px | 590 | -0.01em |
| Task / row title | 13px | 500 | -0.01em |
| Row subtitle / meta | 11px | 400 | 0 |
| Section label | 10px | 600 | 0.14em, uppercase |

Numerals always `font-variant-numeric: tabular-nums`.

## Motion (from the shipped app — reuse, don't reinvent)

```
--ease-drawer: cubic-bezier(.32,.72,0,1);   /* the notch's signature morph */
--ease-out:    cubic-bezier(.23,1,.32,1);
```
- Notch resize (height/width/radius): 420ms `--ease-drawer`.
- Screen swap inside the notch: outgoing 140ms ease-out, incoming 200ms ease-out
  from `translateY(4px) scale(.99)`. Never `scale(0)`.
- Row hover: background only, 120ms. Row press: `scale(.985)`, 120ms.
- Rows entering a list: 30ms stagger, capped at 6 items. Decorative — never blocks input.
- Respect `prefers-reduced-motion`: keep opacity, drop movement.

**Anti-patterns (auto-reject):** gold anything · Helvetica Neue · emoji as icons ·
`transition: all` · `ease-in` on entrances · a separate settings window · a modal ·
border-radius above 20px on the collapsed pill · animating the ticking digits.

## Screens the notch must contain

| Screen | Height | Contents |
|---|---|---|
| `pill` | 32 | dot · task name · time |
| `timer` | 150 | R2-01 layout, unchanged skeleton |
| `tasks` | 250 | list of user tasks; select → arms timer; `+` to create inline |
| `settings` | 250 | focus/break length, launch at login, tray icon, sound, vignette, shortcut |
| `menu` | varies | the router — how you get between the three above |

Task item model: `{ id, title, estimate (pomodoros), done (count), archived }`.
Selecting a task sets the pill's name and arms the timer. Completing a focus session
increments `done` on the armed task.

## The 4 candidates — each a different answer to "where does the menu live"

**C1 · Stack.** Screens replace each other in place; the notch animates its own height.
A single back chevron top-left. Simplest mental model, one thing on screen at a time.

**C2 · Command.** No screens. One persistent list; a text line at top filters across
tasks, settings and actions at once ("45" → set duration, "wri" → the writing task,
"vig" → vignette toggle). Enter runs the top hit. The Raycast answer, taken literally.

**C3 · Tray.** The timer card never leaves. A second tier slides out *below* it for
tasks or settings, so the notch becomes two stacked slabs and you keep seeing the clock
while you browse.

**C4 · Rail.** A 34px icon rail appears down the left inside the expanded notch;
content swaps beside it. The only candidate where navigation is always visible.

All four: same tokens, same type, same motion, same R2-01 timer home screen.
They differ only in navigation architecture and the shape the notch takes to host it.

## Deliverable

A `Round 3` section appended **above** Round 2 in
`review/notch-variations.html`, using the existing `frame()` helper, ids `R3-01`…`R3-04`.
Each frame must be **interactive**: clicking through the navigation works, the task list
selects, settings toggle, and the duration picker still works (scroll + click-to-edit).

## Production handoff — 2026-10-09

Thomas requested implementation of the Figma screen work in the actual Electron app.
The older Instrument comparison selection is superseded by this clarification.
Lead owns taste and final review; executor is GPT-6 Luna at high effort.
Navigation choice is pending: Stack, Command, or both. Build shared foundations first.
No worktree, Git mutations, packaging, publishing, Task OS integration, or Figma writes.

Canonical screen data: `~/Everyday/output/focus-notch/Focus_Notch_Screen_Flows.json`.
The local HTML with the same basename is the reviewable reference. Figma board exists
but failed font/layout QA and its corrective MCP write is blocked by plan quota.
Use the saved screen data and the locked tokens above. Example tasks are illustrative;
never seed them into Thomas's real store.

### Phase 1 — native foundations (independent of navigation)

Keep changes in existing main.js/preload.js; preserve durations, statistics and unknown
existing store fields. Defaults add tasks=[], armedTaskId=null, trayIcon=true, sound=true,
vignette=true, shortcut='Alt+Space'. Persistent task shape is exactly
{id,title,estimate,done,archived}; title trimmed, nonempty and at most 120 characters;
estimate integer 1–99, done nonnegative integer. IDs stable and unique.
Do not invent archiving UI.

Extend the existing context-isolated IPC bridge with:
- settings-save as an invoke that validates allowed fields and returns accepted store
  values. Duration integers 1–90; switches must be booleans. Expose launch-at-login's
  actual native result/error, never display a fabricated success.
- tasks-save invoke accepting validated tasks and armedTaskId. Persistence failures
  reject and leave the previous store intact; renderer can show a compact inline error.
- session-complete invoke accepting mode/minutes plus the task ID captured at focus
  session start and a unique session ID. Completing a focus increments that task once;
  duplicate completion does not duplicate task/stat counts. Break completion does not
  count as a focus pomodoro. Persist before returning the updated tasks/statistics.
- settings-load remains existing invoke and returns merged defaults + old store.
- native notch content height 290px, width420px: large enough for 250px notch and its
  shadow, without new resize IPC. CSS notch itself morphs 196x32 / 312x150 / 332x250.
  Preserve top-edge placement, shoulders, dragging, fullscreen/workspace behavior and
  mouse click-through.

Tray icon preference creates/destroys the existing Tray; hiding it still leaves the
global shortcut and native app menu available. Shortcut update registers the new
accelerator before unregistering the old one; invalid/unavailable registration rejects
and preserves the prior working binding. Exclude unmodified letters/numbers; require
Alt/Ctrl/Cmd plus a key (Shift alone is insufficient).
Sound uses Electron shell.beep on completion; vignette remains existing overlay IPC
and is gated by the accepted stored preference. Overlay focus tint must become
achromatic; completion uses #b9ea9c/#7fc06a only, including break completion.

Use standard library validation and atomic file replacement for store writes; no new
dependency/framework, service layer, generalized architecture or credentials. Verify
syntax and a small meaningful native persistence/shortcut regression where feasible.
Phase 1 does not replace index.html/renderer.js yet: lead sends exact screen brief
after the navigation choice. Return changed files, contracts, checks and unresolved risks.

### Phase 2 — locked screens, Stack default

Navigation preference question remains optional. Lead defaults to Stack after allowing
response time; do not add a navigation variant switch. If Thomas chooses Command before
completion, revise this route brief. Build the 12 shared T states + six Stack S states
from the canonical scene JSON. This is actual production functionality, not mock screen
copies. No example task data or copied demo names in real storage.

Visual implementation is exact:
- Native -apple-system, "SF Pro Text", system-ui, sans-serif. No Inter substitution in
  Electron (Figma's missing-font problem is specific to its MCP renderer).
- Tokens from above only. Achromatic focus; green only break/completion. Remove lime,
  circular dial, italic cue, purple sheet, center disk, radar and progress knob.
- Black concave shoulders 14x14 at top; notch top flush to screen edge; top canvas strip
  28px, body surface. No texture. 1px hairline only where scene shows fields/dividers.
  Bottom corner radius 22px expanded, 16px collapsed. Gentle black shadow, no colored glow
  in expanded screens. Preserve existing collapse border-travel if recolored white.
- Pill 196x32: padding14px, dot5px, gap8px, label flexible truncated, time12.5/590
  tracking-.01em/tabular. Idle dot dim, running white, break green; no speculative badge.
- Timer 312x150: exact scene coordinates relative notch: task x20 y33 (13/500),
  ellipsis x272 y29; modes x20 y60 width52x23 and x80 y60 width54x23, selected raised
  bg radius6 and labels10/600. Numeral x20 y89 (38/300 tracking-.03em/tabular, line
  height46). Controls x250 y94 size34 square radius9, icon16; secondary x218 y104
  icon15 (use a transparent 28px hit area centered there). Pause note or completion
  count x20 y133 size8–9. Keep task-title clear of the ellipsis (truncate maxwidth240).
  Native buttons with focus-visible outline and accessible names. Reuse exact play/
  pause/reset/check SVG strings from review/notch-variations.html and R3I icons.
- No extra button next to ellipsis: Escape or clicking card's empty space collapses.
  Pill click/drag retains existing behavior, expanded backgrounds do not intercept
  all transparent native window pixels. Inactive screen contents inert/untabbable.
- Stack menu 332x176: back icon x18 y37, Timer label x44 y38; section x18 y65.
  Task/settings rows x10 y88/y124, width312 height32; row background only hover/
  keyboard selection; icon16 +24px title offset, meta11 at right.
- Tasks 332x250: same header, plus at x301 y60; rows y85 with37px stride,
  selected bg raised radius6, title13/500, done / estimate11/400. List scrolls for
  overflow; footer at x18 y213. Empty screen matches S03 copy and inline New task.
- Inline create 332x250: back Timer + NEW TASK, title field x18 y88 296x34, estimate
  row y134, cancel x18 y203, Add task x226 y193 88x32 white/radius6. Estimate defaults
  1, bounds1–99; nonempty trimmed title≤120. Add persists before select+timer, cancel
  leaves no task. Title input gets focus; empty title Add disabled. Failure shows small
  readable inline error and retains draft. Escape cancels draft first.
- Settings 332x250: back icon x18 y34 + Settings x43 y35. Rows starty62 with25px
  stride, labels13/500 atx18 y+5; controls alignedright14–18px. Seven rows: focus,
  break, launch login, tray, sound, vignette, shortcut. Toggle28x16 radius8; on white
  track / black knob12x12 at right; off raised / mid knobleft. No colored toggle.
  Focus/break have actual -/numericvalue/+; focusstep5, breakstep1, clamp1–90.
  Actual OS response governs accepted settings; failed save shows inline error,
  setting remains previous value. Native submenu Preferences opens this screen.
- Shortcut 332x250 S06: back Timer, SHORTCUT label, press-new text y104; field
  x18 y136 296x42; chord16/500; Enter-save / Escape-cancel hint11 y193. Capture
  current binding initially, allow only Alt/Ctrl/Cmd+key (Shift optional); Enter alone
  saves and Escape alone cancels. Candidate replaces stored binding only on success.
  Restore suspended shortcut on cancel, navigation away, collapse, blur/hide.
- Morph width/height/radius420ms cubic-bezier(.32,.72,0,1). Content exits140ms,
  enters200ms from translateY(4px) scale(.99). Row bg120ms/pressscale.985.
  No transition:all; no ticking-number animation. Reduced motion removes translation,
  scale, morph movement and decorative pulses; retain short opacity change.

Behavior/state:
- Start arms active session with unique session ID and a snapshot of selected task ID.
  Start auto-collapses pill, countdown continues through all screens. Use elapsed clock
  time (deadline) rather than losing time on throttled animation frames. Pause updates
  remaining first and preserves it; dial and pill always match. Resume keeps session ID.
  Reset cancels unfinished session, preserves task selection, restores current length.
- Timer task title opens tasks. Menu opens via ellipsis. Back from every Stack screen
  returns to timer. Escape from a destination returns timer; Escape at timer collapses.
  During running session disable task selection, duration editing and mode changes
  without interrupting the clock; allow task creation and preference changes for next
  session. A short inline explanation is permissible for disabled actions.
- Paused duration change or selecting a different task deliberately re-arms a fresh
  ready timer; do not increment counts. Duration click reveals minutes field as T08;
  min1 max90, Enter commits integer, Escape cancels, wheel±1 or Shift±5 when not running.
  Editing DOM is stable while ticks/render update; never overwrite input/caret.
- Natural end or explicit Finish transitions to T09/T12 inside expanded timer, 00:00,
  check primary action. Do not immediately jump modes. Only a focus completion increments
  captured task and session count once; reset/pause/re-render/break do not. Full focus
  minutes on natural end; actual elapsed whole minutes on early finish, never full
  duration when zero seconds elapsed. Task done may exceed estimate.
- T09 primary Continue enters ready break T10, 5min/defaultsaved length; starts manually.
  T12 primary returns ready focus with selected task. Completion notifies, sounds if on,
  and existing overlay celebrates green; vignette off on pause/break/completion or setting
  off. Remove gold and lime from overlay. Use stored tasks/stats returned by completion
  IPC; retry/error must not duplicate recording. Keep finishing state safe while invoke
  is pending.
- Start/Pause/Finish/Reset from existing tray/native menus call the same state functions.
  Space acts only from timer/pill without editable input/shortcut capture; do not let
  focused buttons get both keydown action and their native synthesized click.
- Persist real tasks, armed selection, preferences and statistics via existing store;
  no Task OS files touched. A fresh install has no seeded tasks. Existing stats/durations
  must survive. Do not add onboarding, archive UI, installer, purchase screens or analytics.

Verification: existing npm test plus one self-contained Electron regression runner,
using installed Electron/Node assert, no new test dependency/framework. Run UI through
real DOM events and preload/native contracts or realistic bridge fixtures; isolate data
in a temp userData directory, suppress real notifications/sound/login edits in tests.
Exercise task create/select/reload, empty lists, pause/resume/reset and elapsed ticks,
one-time focus count/manual break, error paths, settings toggles/shortcut rejection,
keyboard input safety, long-title truncation, scroll and bounding rectangles at actual
pixel dimensions. Include reduced-motion check. Capture deterministic screenshots of
timer, paused, completion, tasklist, empty/create, settings and shortcut to review/.
Lead reviews images and final diff before delivery; no fake claims that Figma was repaired.


### Implementation verification — 2026-10-09

Implemented the locked Figma screen direction in the actual Electron app. Stack is the
lead's stated default after the optional navigation question remained unanswered;
Command remains in the design comparison. The older Instrument selection is superseded
by Thomas's clarification. GPT-6 Luna high executed; lead owned visual and final review.

Twelve timer states and six Stack destinations are functional: local tasks, inline
minutes, preferences, shortcut capture, pause/resume/reset, explicit focus/break
completion and manual break start. Atomic persistence preserves drafts/state on failure;
completed session IDs prevent duplicate counts. Task and total duration are captured at
session start, so changes for the next session cannot alter the active session's record.
Production profile has no seeded tasks. No dependencies, separate settings window,
Task OS integration, packaging or Figma changes were added.

Validation passed:
- `npm test`: package/source presence and JavaScript syntax.
- `npm run test:native`: isolated mocked native persistence, atomic-write failure,
  validation, stale task counts, completion dedupe, sound failure, login rollback,
  tray lifecycle and shortcut rejection/capture restoration.
- `npm run test:ui`: actual Electron window, DOM, preload and isolated IPC fixtures;
  task create/select/reload/failure, add during active focus, pause/resume/reset,
  natural focus duration snapshot, break without focus counts, completion retry,
  keyboard Space/input safety, shortcut physical key/cancel, collapsed inertness,
  focus scroll bounds, long-title overflow and reduced motion.
- `git diff --check`.

Lead inspected all eighteen visual states in `review/visual/`; fixed the compact minute
field and focus-induced root/notch scrolling. Review gallery: `review/Locked_App.html`.
Eighteen interaction captures are in `review/evidence/`. Synthetic Cmd+A did not route
through macOS menu handling in the harness; focused native Select All and replacement
were verified. Standard production Edit menu is present.

Actual production main/preload/renderer opened and left expanded/idle at the top edge.
Notch geometry 312 × 150, native window 420 × 290, top 0; real focus 2min / break 5min,
zero tasks, sessions and recorded minutes. Real store SHA256 remains byte-identical:
`3c865335365ebd717cc46fbc96739305814739399f928f694cbdfd9edf0fd701`.
Actual Alt+Space registration and Edit menu verified. Capture:
`review/visual/Actual_Profile.png`. macOS reports a login-item operation-not-permitted
error; enabling launch at login remains unverified. Figma's separate font/container
repair remains blocked by Starter-plan MCP quota.

Existing checkout `launch/ready-to-sell`, commit `22fdefb`, no configured remote.
No Git mutations or worktree. Not remotely saved.


## Screenshot revision — 2026-10-11

Current user reference: `review/Reference.png` (original attached screenshot). User explicitly requests Rinter, Neue Haas only if unavailable. Installed Rinter Regular found; bundle `assets/fonts/Rinter.otf`, declare real @font-face, use Rinter globally with font-synthesis:none. Rinter has one regular weight; do not fake a thin weight or substitute Inter.

Lead geometry at native 312px body width (reference enlarged about 3.013×):
- Expanded timer 312 × 103. Existing collapsed 196 × 32 and other destination dimensions unchanged.
- Expanded timer canopy #07080a; rounded body #0d0e12 starts at y21.5 with 19px corners. No border or shadow on expanded timer.
- Shoulder flares 28 × 38, concave elliptical edge: left cutout ellipse centered x0,y38 with radii28,38; right mirrored. Only expanded timer gets these shoulders.
- Navigation: three dots centered at x10.5,19,27.5/y14.5; left menu hitbox x4,y3,w32,h22. Dots 3.8px circles (SVG or CSS), no literal text-glyph ellipsis.
- Focus left117,y7; Break left158,y7, both 13px/400, 17px line-height, no tab background. Active Focus #03c3d1, inactive #9ca1ab. Break active keeps existing green.
- Add task plus centered x300,y14, 14px icon; hitbox x287,y2,w25,h24. Wire existing data-create action, clear draft and open create. Guard/disable during completion save as appropriate.
- Task title x16,y34,w276,h18; Rinter 13px/400, line18; selected focus title #ff8d28. Real task text remains data-driven.
- Timer x13,y56,wauto,h46; Rinter 38px/400, line46, tracking -.03em, ink #f4f4f6. Keep existing edit duration control functionality and input safely inside body.
- Reset hitbox x236,y60,w28,h28, 15px icon #9ca1ab. Play x267,y57,w35,h35, radius9, background #5f646d, black icon16. Completion primary remains green.
- Paused/completion note x16,y91, line10, font8; hidden ready/running as before. Error notice on timer goes over task row at y34, opaque surface background; hidden title while notice showing so they do not collide. Other screens retain existing notices.
- Ensure state.screen dataset sync in render, including collapse/start, for conditional timer geometry. Update all three renderer hardcoded timer heights150→103.
- Other destinations keep working layout; globally use real Rinter with no synthetic bold. Preserve timer, task persistence and shortcut logic.

Verification: existing smoke and Electron UI regression; update prior geometry expectations to103, verify new timer plus action and native font actually renders Rinter. Lead reviews all recaptured states and exact sample-reference scene before opening result. No real-profile task seeding or destructive Git operations.

### Lead review and verification — October 11

Screenshot layout implemented with bundled Rinter Regular. Matched native312×103 geometry, cyan Focus tab, orange selected task, charcoal play button, canopy curves and title/control placement. Rinter has only Regular: timer numerals are visibly heavier/wider than the screenshot; no claim of pixel-identical typography. The review gallery now presents reference/current captures side by side.

Lead corrected shoulder direction, lower-corner clipping, default button padding, numeral alignment, collapsed header bleed and stale notice title visibility. Rinter's blank minus character was replaced with SVG decrement icons. Existing 18 state captures refreshed; Chromium CSS.getPlatformFontsForNode confirms custom Rinter-Regular actually renders.

Final npm test, npm run test:ui and git diff --check pass. UI coverage includes actual font loading, topbar plus, collapsed control visibility, and all existing timer/task/persistence interactions. One concurrent visual/test run exposed the harness's fixed animation wait; the harness now waits for settled collapsed bounds and disables background throttling. Sequential final run passed. No native source changed this revision; earlier native verification remains recorded above.

Actual user has continued using production since October9. Current saved state was read only; no sample tasks were seeded and no real data written. Restart question is pending; current process remains untouched to preserve any live countdown. Actual_Profile.png is explicitly labeled historical in the gallery. Source changes are ready for restart. No Git mutations/worktree; Not remotely saved.


## Direct instrument stance and gesture revision — 2026-10-11

User asks to simplify the screenshot-based flow, apply emil-design-eng, use SF Pro Light for timer numerals, drag numbers to define pomodoros, and move notch only on X while glued to screen top. Existing screenshot shape/colors remain locked. Rinter stays for labels.

Design stance: quiet, direct instrument. The timer is the work surface; optional tasks give context. One obvious next action, direct manipulation and immediate feedback. No ornamental bounce, moving numerals, keyboard animation, or navigation ceremony. Frequent actions stay immediate; short opacity/color feedback only. Precise duration and window drags track the pointer without momentum.

| Before | After | Why |
| --- | --- | --- |
| Dots → Navigate → Settings | Dots → Settings | Remove an intermediary screen |
| Click number, type, confirm | Drag number left/right; click still types | Most adjustments happen on the timer itself |
| Completion check → ready break → play | Completion play starts next session | One explicit action carries the flow forward |
| 420ms width/height morph | Immediate shell geometry; 90ms exit / 120ms entry opacity | Frequent actions respond immediately without layout animation |
| Rinter timer Regular | Installed SF Pro Display Light, 300 | Match the requested thin numeral contrast |
| Pill can move down the screen | Pill/topbar drag X only; Y equals display.bounds.y | Keep notch attached to the top edge |

### UI execution contract

- Keep312×103 timer composition, canopy/body/shoulders, cyan #03c3d1 Focus, orange #ff8d28 task, gray #5f646d primary, green break/completion and all existing data/persistence protections.
- @font-face `TimerSF` from local('SF Pro Display Light'), local('SFProDisplay-Light'), weight300/style normal; no Apple font file bundling. .clock, .clock-edit and .pill-time use TimerSF,-apple-system,'SF Pro Display',sans-serif at300. Keep timer38px; align glyph visually in final lead review. Labels Rinter400.
- Remove intermediary menu view/markup/CSS, views.menu and menuTaskCount updates. Dots #openMenu opens settings directly, aria-label/title='Settings'. Task title → tasks, + → create. Keep task picker/create/settings/shortcut. Shortcut back → settings; Cancel create → timer, clearing draft; no extra navigation when cancelling.
- Completed primary uses play icon and accessible label/title='Start break' or 'Start focus'; on press continueFromCompletion resets completion and starts next mode immediately via startTimer. Saved completion still waits for explicit action; unsaved completion retry still uses check and never starts next session on retry automatically. Do not auto-start next session at countdown zero.
- Drag digits horizontally: 6 CSS/screen px per minute, round displacement, clamp1..90. Use 4px activation threshold. Idle or paused only; blocked running/completion/save busy/inline editing. Pointer capture on stable clockSlot, ignore secondary pointers, prevent selection. Preview number and accessible label immediately without full task-list rerender, save once on release through existing settings queue. Save success rearms/reset duration; failure restores saved duration/state with existing notice. Escape/pointercancel/window blur cancels without write. Click (no drag) retains inline editor; completed drag must suppress click-to-edit. Ignore wheel/keyboard/other duration edits while active drag or its save is pending. Start cannot use unsaved preview.
- Clock hover/cursor ew-resize when editable. Native title='Drag to set minutes · click to type', visible microhint only while hovering/focused idle timer in existing timerNote slot, e.g. 'Drag to set minutes' (8px mid, no tooltip animation). Running/paused/completion labels retain priority. Keyboard ArrowLeft/Right on focused clock adjusts ±1 minute (Shift±5), bounded1..90 via existing persistence. Keyboard events never animate.
- Notch dragging uses pointer events/capture on island, either collapsed pill or expanded empty canopy y0..26 on all screens excluding buttons/inputs. Threshold4px total pointer movement; suppress pill expansion/backdrop collapse after drag. Replace old mouse :active polling. Native API window.notch.dragStart()/dragMove()/NEW dragEnd() (lead implements preload/main). Force mouse passthrough off while either gesture captures pointer, restore bounds-based passthrough at end. Window drag also cleans up cancel/blur. No number/window drag confusion.
- Geometry transitions removed entirely. Views use opacity only, entry120ms strong --ease-out, exit90ms; pill opacity90ms. Native keyboard commands/expand/navigate and DOM keydown add .instant-ui on root/island; transitions/animations none there. Pointerdown clears .instant-ui; keyboard activation of buttons also instant. No scale/translate on screen navigation. Pointer presses scale .97 for100ms; reduced motion removes movement, permits brief opacity/color; keyboard .instant-ui overrides all transitions. Respect existing collapsed inertness and scroll bounds.
- No dependencies or abstractions, no changes to real profiles, no native settings calls, no Git mutations/worktree.
- UI runner: adapt removed menu paths and completion flow. Meaningful regression checks: pointer-generated duration drag commits once; cancel no write; clamping, blocked running/save failure; release does not open input; duration gesture does not send notch drag events; window gesture sends start/move/end and suppresses click; direct settings; keyboard no animation. Use actual Electron sendInputEvent for primary gesture checks when feasible, stable coordinates after settled geometry, existing isolated fixtures. Preserve previous failure/count/session regressions.

Lead owns main.js, preload.js, native-foundations tests, gallery/visual harness and tracking. Worker owns index.html, renderer.js, electron-regression.js. Ask lead if contract ambiguity prevents safe implementation.


### Final lead review and verification — direct instrument revision

Implemented the stance above in production source. Timer numerals, minute input and collapsed timer use SF Pro Display Light 300; labels retain bundled Rinter. Numeral slot is x13/y50, preserving visual alignment in the 312×103 body. Chromium platform-font inspection confirms SFProDisplay-Light for digits and Rinter-Regular for labels. All17 current state captures were refreshed and reviewed; the removed Navigate view is no longer surfaced. The reference comparison and simplified flow are in Locked_App.html.

The dots open Settings directly; task title opens Tasks and plus opens Create. Cancel/Escape from Create returns to the timer; Shortcut returns to Settings. Saved completion play starts the next session immediately on explicit press. Natural countdown completion still waits, and failed-save retry cannot start the next session automatically.

Duration gestures preview immediately, retain the preview while saving, persist once, and do not open the inline editor on release. Pointer capture keeps dragging active outside the number; Escape/cancel/blur abort without a write. Running, completion, pending duration saves and task writes cannot start from an unsaved preview. Keyboard arrow adjustment and click-to-type remain available. Drag hints and cursors identify the editable number and the actual draggable canopy only.

Native notch Y is pinned to display.bounds.y on every move/show/display change. X stays within the current display; release ends native dragging. Display origin can be negative. Both gestures hold mouse passthrough off while captured, then restore hit-testing. Layout changes are immediate; screens use 90/120ms opacity, pointer press feedback is brief, keyboard actions have no animation and reduced motion is respected.

Validation passes: npm test, npm run test:native, npm run test:ui and git diff --check. UI checks include actual Electron mouse down/move/up for duration and pill drags, one-save/no-editor behavior, held preview/start guarding, cancellation/clamps, canopy dragging on Settings, immediate deliberate click after drag, keyboard motion rules and the previous failure/retry/task/session regressions. Native mock checks add top pinning, release, X bounds, negative display origin and display removal.

A separate production-main/preload/renderer preview is open using an isolated sample profile, with OS login preferences and global shortcut writes disabled. Actual Electron pointer scrub25→31 saved once and did not open the editor; real native window positioning repinned Y, accepted X-only dragging and stopped after release. Capture: visual/Interactive_Preview.png. The original running app and its profile were preserved; source changes take effect there on its next restart. No installer, Figma repair, Task OS integration, Git mutation or worktree. Existing branch launch/ready-to-sell, no remote. Not remotely saved.


### Sensory focus initiation — 2026-10-11

User requests a fullscreen dark start transition, about ten seconds, with a smooth sound cue. Reused the existing click-through overlay, adding one neutral dark edge layer and a soft Web Audio A3/E4 sine cue (220/330Hz, approximately1.8s, low gain). No downloaded sound/dependency. Intro fades in0–1.8s, holds to4.2s, fades to transparent by10s; centre remains readable and the existing ambient focus vignette remains underneath. Opacity only; reduced motion softens peak to60%. Timer starts immediately and never waits for sound or overlay.

| Before | After | Why |
| --- | --- | --- |
| Focus start only collapses the notch | Ten-second dark edge wash with short soft cue | Give fresh focus a clear sensory beginning |
| No separate start effect | Once per fresh session ID, not pause/resume or break | Keep repeated actions quiet and immediate |
| Existing overlay/preferences | Reused overlay, Vignette and Sound gates | Avoid new settings or blocking UI |

Fresh focus sends its new session ID once. Pause/reset/mode change/finish cancels with a240ms fade and fast audio release; completion retry never replays. Main validates/dedupes IDs and gates visual/audio independently by stored preferences. Turning off either preference cancels the current intro. Overlay Web Audio has explicit autoplay permission and background throttling disabled, while overlay remains nonfocusable/click-through. Audio-device failure cannot affect session state.

Validation passes: smoke, native, actual Electron UI, new `npm run test:overlay`, diff/syntax checks. Overlay suite checks actual10,000ms timing/keyframes, end opacity, cancellation, AudioContext running while output muted, independent sound-only, reduced motion and pointer-events:none. Cancellation fixture waits for settled opacity because IPC/frame delivery is asynchronous. Native gates/dedupe and renderer fresh/resume/break/reset/retry lifecycle covered. Lead reviewed peak/settled sample captures and source. Separate production-code preview played the full live cue and verified timer immediate, running AudioContext,10s fade completion; sample timer then reset. Original real profile SHA256 still unchanged from initial turn.

Replayable artifact `review/Focus_Initiation.html` embeds the exact production overlay CSS/script against a sample workspace; also embedded in Locked_App.html. Peak/settled captures in visual/Focus_Initiation_*.png. This browser demo is a generated review projection; production implementation remains overlay.html/main/preload/renderer. Existing running production instance is preserved, revision applies there on next restart. Isolated updated app preview remains open. Not remotely saved.
