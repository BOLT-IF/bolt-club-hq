# BOLT HQ — Mobile PWA UI & UX Rules

Target: Cross-platform mobile PWA (iOS Safari & Android Chrome) with responsive desktop fallback.
Visual Philosophy: Apple HIG clarity and restraint paired with BOLT HQ's navy-and-amber identity.

---

## 1. Brand & Surface Tokens
* **App Header:** Dark navy (`#1E293B`) with white navigation controls, amber brand mark (`#F59E0B` / `#F97316`), and a subtle amber bottom accent rule.
* **Page Canvas:** Warm off-white (`#FAF8F5` / `#F8F7F4`). Never use pure white for the full page background when cards are white.
* **Elevated Cards & Grouped Lists:** Pure white (`#FFFFFF`), `rounded-2xl`, subtle border (`border-slate-200/70`), and soft shadow (`shadow-sm`).
* **Primary Brand CTA:** Vibrant orange/amber (`#F97316` / `#FF9429`) with **dark slate text (`#0F172A`)** for high contrast (WCAG AAA). Avoid white text on bright orange.
* **Muted / Secondary Text:** Use `#526075` (`--bcq-muted`) rather than raw Tailwind `slate-500` (`#64748B`), which falls just below WCAG AA 4.5:1 on `#FAF8F5` (`4.48:1`). `#526075` achieves ~`6.0:1` on `#FAF8F5` while keeping a calm muted tone.
* **Semantic Status Pills:** Soft tinted fill + darker matching text, `rounded-full`, `text-xs font-semibold px-2.5 py-0.5`:
  * Active / Success: `bg-emerald-50 text-emerald-700`
  * Neutral / Role / Past: `bg-slate-100 text-slate-600` (or warm stone `#F3EFEA`)
  * Attention / Pending: `bg-amber-100 text-amber-800`
  * Destructive / Alert: `bg-red-50 text-red-700`

---

## 2. Typography & Capitalization
* **Title Case (Mandatory):** Use Title Case for all page headers, section titles, navigation rows, form labels, status badges, and button labels (e.g., `Terms & Series`, `Invites & Join Requests`, `Club Finances`, `Make Admin`, `Copy Link`, `Audit Log`).
* **Sentence Case:** Use sentence case for subtitles, helper copy, empty-state explanations, and confirmation dialogs (e.g., `"New requests appear here and in your inbox."`).
* **Section Subheaders:** `text-xs font-semibold uppercase tracking-wider text-slate-500 px-1 mb-2`.
* **Data Formatting:** Stack distinct metadata fields cleanly on separate lines. Never leave orphan punctuation (e.g., trailing `·` before a line break).

---

## 3. Button Hierarchy (No Plain Outlined Boxes)
Avoid plain white buttons with `1px` dark borders—they read as text fields or static boxes. Every button must look unmistakably tactile and follow a 4-tier hierarchy:

1. **Filled Primary (Highest Prominence):** Brand amber/orange (`bg-orange-500 text-slate-950 font-semibold`). Limit to **one** primary action per view or form.
2. **Filled Tonal / Gray (Standard Secondary):** Soft neutral fill (`bg-slate-100 hover:bg-slate-200/70 text-slate-900 font-semibold`, no harsh outer border). Pair with a leading `16–18px` icon for fast scanning.
3. **Soft Red Tonal (Destructive Trigger):** Soft pink fill with dark red text (`bg-red-50 hover:bg-red-100 text-red-700 font-semibold`). Use on cards and inside action sheets.
4. **Solid Red (Final Destructive Confirm Only):** Solid red (`bg-red-600 text-white font-semibold`). Reserve **exclusively** for final confirmation modals/sheets (e.g., `Deactivate`, `Revoke Link`). Never repeat solid red buttons across list rows.

**Button Sizing & Feedback:**
* Minimum height `44px` (`min-h-[44px]`), `rounded-xl`, single-line labels (1–3 words).
* Always include press feedback: `transition active:scale-[0.98]`.
* Provide instant inline feedback for quick actions (e.g., `Copy Link` temporarily switches to `✓ Copied` in emerald tint for 2 seconds).

---

## 4. Lists, Cards & Actions
* **Zero Multi-Row Button Grids on Cards:** Never place two rows of buttons or 3+ inline buttons on repeating list cards.
* **Overflow (`⋯`) + Bottom Action Sheet:** When a list item has 3+ actions (or destructive actions), remove inline buttons from the card and place a single `44×44px` `⋯` button in the top-right corner (or make the card tappable) that opens a Bottom Action Sheet:
  * Show the target item's name and key metadata in the sheet header for context.
  * Stack full-width tonal action rows (`min-h-[48px]`) with leading icons.
  * Physically separate destructive actions below a subtle divider (`border-slate-200`).
  * Include a drag handle pill, backdrop dismiss, `Escape` support, body scroll lock, and a `Cancel` button.
* **Inset Grouped Lists (Settings & Admin Hubs):** Group related destinations into logical sections inside single white containers with subtle internal dividers (`divide-y divide-slate-100`) instead of separate floating cards.
  * Left: `18px` icon inside a `32×32px` tinted rounded square (`rounded-lg bg-slate-100` or `bg-amber-50`).
  * Right: Optional glanceable count/badge + right chevron (`›`, `text-slate-400`). Only show chevrons on rows that navigate to a new screen.
* **Badge Placement on Cards:** Place status pills below long titles or right-aligned cleanly so long names never collide with badges.
* **Smart Sorting & Past States:** Always sort `Active` or `Pending` items above `Revoked`/`Expired`/`Inactive` items. Collapse historical items into a closed-by-default disclosure (e.g., `Past Links (N)`). Never display future expiry timestamps on revoked items.

---

## 5. Spacing, Forms & Empty States
* **Vertical Rhythm:**
  * Between major page sections: `space-y-6` (`24px`).
  * Between stacked cards within a section: `space-y-3` (`12px`).
  * Internal card padding: `p-4` (`16px`).
  * No button or heading may sit flush against an adjacent card border.
* **Forms:** Wrap inline forms in a matching white card container so they align visually with surrounding cards. Place short numeric/paired fields (e.g., `Valid For (Days)` and `Max Uses`) side-by-side in a `grid-cols-2 gap-3` row.
* **Compact Empty States:** Use a single-row left-aligned card with a leading `36×36px` tinted icon container instead of tall, centered blank boxes.

---

## 6. Android & iOS PWA Standards
* **Safe Areas:** Apply `pb-[max(1rem,env(safe-area-inset-bottom))]` on fixed bottom nav bars and Bottom Action Sheets, and `pt-[env(safe-area-inset-top)]` on fixed headers.
* **Bottom Clearance:** Give all scrollable page containers bottom padding (`pb-24` or nav height + safe area) so the final list item is never clipped by the bottom tab bar.
* **Viewport Units:** Use `min-h-dvh` instead of `min-h-screen` (`100vh`) to prevent iOS Safari address-bar jumpiness.
* **Prevent iOS Auto-Zoom:** Keep all `<input>`, `<select>`, and `<textarea>` elements at `16px` (`text-base`) minimum font size. Use `inputMode="numeric"` or `"decimal"` for number fields.
* **Native Touch Feel:**
  * Enforce `44×44px` minimum tap targets on all interactive icons and links.
  * Apply `touch-action: manipulation` globally to interactive elements (removes double-tap zoom delay).
  * Set `-webkit-tap-highlight-color: transparent` and rely on explicit `active:` background/scale states.
  * Never hide critical actions behind hover-only states.
* **Confirmation Friction:** All hard-to-undo actions (`Deactivate`, `Revoke`, `Delete`) must require an explicit confirmation step before mutating state.
