import { ref } from 'vue'

/**
 * Whether the hide mode is applied, as one answer for the whole app: a `.mchide`
 * file says *what* a folder hides, and this says whether those entries are left
 * out at all. It is a module-level ref rather than per-pane state, so a toggle in
 * one pane re-filters every pane — including the tabs that are not on screen —
 * and both panes' title bars read the same thing.
 */
export const hideMode = ref(true)

/**
 * Ask main for the mode that was left on last time. Called once, before the
 * panes walk their first directory, so the answer is in before any row is built
 * — there is a default here only for the moment that takes.
 */
export async function loadHideMode(): Promise<void> {
  hideMode.value = await window.mc.hide.get()
}

/**
 * Alt+. — switch the mode off and on. The `.mchide` files are untouched either
 * way; only whether their lists are applied changes, and the choice is written
 * down so the next launch remembers it. Every pane's rows follow through the
 * watchers on `hideMode`.
 */
export async function toggleHideMode(): Promise<void> {
  hideMode.value = !hideMode.value
  await window.mc.hide.set(hideMode.value)
}
