# Mobile chat viewport design QA

## Evidence

- Source visual truth:
  - `/tmp/codex-remote-attachments/019ff099-464c-7242-9d25-c9e6d9a74b5d/B6A0C0F8-973C-45C4-ACCB-73B4D2267191/1-Photo-1.jpg`
  - `/tmp/codex-remote-attachments/019ff099-464c-7242-9d25-c9e6d9a74b5d/B6A0C0F8-973C-45C4-ACCB-73B4D2267191/2-Photo-2.jpg`
  - `/tmp/codex-remote-attachments/019ff099-464c-7242-9d25-c9e6d9a74b5d/B6A0C0F8-973C-45C4-ACCB-73B4D2267191/3-Photo-3.jpg`
- Browser-rendered implementation:
  - `/tmp/newscraft-mobile-qa/after-reading.png`
  - `/tmp/newscraft-mobile-qa/after-focus.png`
- Combined comparison: `/tmp/newscraft-mobile-qa/comparison.png`
- Source pixels: 588 by 1280 for each iPhone screenshot.
- Implementation pixels and CSS viewport: 390 by 844 at device scale 1.
- Additional responsive checks: 320 by 700 and 430 by 932.
- State: signed-in conversation, latest-answer actions visible, composer idle and focused.

## Full-view comparison

The reported states showed three P1 layout faults:

1. Browser chrome covered the top app content.
2. The focused composer used the visual viewport height but ignored its vertical origin.
3. The app shell ended above the visible keyboard boundary and left a large dead strip.

The revised implementation uses the full VisualViewport rectangle. The shell follows both its height and `offsetTop`. The composer ends at the shell bottom. The document does not scroll outside the app shell.

At 320, 390, and 430 CSS pixels:

- the shell filled the visible viewport;
- the composer bottom equaled the shell bottom;
- the command bar remained inside the shell;
- the document had no horizontal or vertical overflow;
- the composer remained visible.

The deterministic keyboard transition used a 390-pixel visual viewport with a 128-pixel top offset. The shell moved to 128 pixels, kept a 390-pixel height, and placed the composer at the 518-pixel visible bottom.

## Focused-region comparison

The top command bar and composer were checked as focused regions because these controls failed in the source screenshots.

- Top command bar: 8-pixel inset in the normal mobile viewport. It now moves with the visual viewport origin.
- Composer: fixed to the visible shell bottom in idle and focused states.
- Keyboard-open composer: safe-area padding is removed while the keyboard is present, which prevents a second bottom gap.

## Required fidelity surfaces

- Fonts and typography: unchanged. Text size, weight, line height, wrapping, and hierarchy match the existing NewsCraft design.
- Spacing and layout rhythm: corrected only at the viewport boundaries. Message, toolbar, utility-bar, and composer spacing are unchanged.
- Colors and visual tokens: unchanged.
- Image quality and assets: unchanged. Existing NewsCraft and icon assets remain intact.
- Copy and content: unchanged.

## Interaction and accessibility checks

- Composer focus remains visible.
- Drawer opens and closes at 390 pixels.
- The close control is visible inside the drawer.
- The message thread remains the only vertical scroll area.
- Browser console: 0 errors.
- Focused mobile browser test: passed.
- Mobile settings browser tests: 3 passed.

## Comparison history

### Iteration 1

- Finding: the first fix used `100dvh` while the keyboard was closed.
- Finding: it used VisualViewport height only when the keyboard was open.
- Finding: it did not apply VisualViewport `offsetTop`.
- Result: blocked by the three P1 faults visible in the supplied iPhone screenshots.

### Iteration 2

- Fix: use VisualViewport height for every signed-in mobile shell state.
- Fix: position the shell at VisualViewport `offsetTop`.
- Fix: detect keyboard shrink against the last resting visual viewport instead of `innerHeight`.
- Fix: keep the shell fixed to the visible viewport and keep scrolling inside the thread.
- Fix: remove bottom safe-area padding while the keyboard is open.
- Evidence: focused viewport-offset regression test passed; real 320, 390, and 430 browser checks passed; combined comparison reviewed.

## Residual limit

Desktop browser automation cannot display the native iOS software keyboard or browser controls. The regression test reproduces their reported VisualViewport height and offset values. A final physical-iPhone check is still useful after deployment.

final result: passed
