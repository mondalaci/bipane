/**
 * The file that puts a directory in hide mode. Main reads it as a list of names,
 * one entry per line, and reports them; the pane leaves those entries out of the
 * listing while the mode is on. The pane's title bar names the file in the icon's
 * tooltip, so the two sides read the same word from one place rather than each
 * holding their own copy of it.
 */
export const HIDE_MARKER = '.mchide'

/**
 * The key that switches the mode off and on (see `App.vue`). It is named in the
 * tooltips because the icon is the only place the gesture is discoverable, and
 * one spelling of it keeps the two states from drifting apart.
 */
export const HIDE_MODE_KEY = 'Alt+.'

/**
 * What the icon says while the mode is on: which file is doing the hiding, and
 * how to see what it is covering up.
 */
export const HIDE_MODE_TOOLTIP = `Hidden mode: the ${HIDE_MARKER} file in this folder is hiding the entries it lists. ${HIDE_MODE_KEY} shows them.`

/**
 * What it says while the mode is off — the file is still there and still lists
 * entries, so the icon has something to explain rather than simply vanishing.
 */
export const HIDE_MODE_OFF_TOOLTIP = `Hidden mode is off: the ${HIDE_MARKER} file in this folder lists entries, but they are being shown. ${HIDE_MODE_KEY} hides them again.`
