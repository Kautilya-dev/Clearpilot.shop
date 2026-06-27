// Pushes saved Styling preferences onto the page so question/answer bubbles can read them
// via CSS custom properties (set once here, consumed anywhere with var(--style-*)) instead
// of needing every component that renders a bubble to know about the settings object.
export function applyStyles(styles) {
  document.body.style.backgroundColor = styles.overallBg
  const root = document.documentElement.style
  root.setProperty('--style-question-bg', styles.questionBg)
  root.setProperty('--style-question-font', styles.questionFont)
  root.setProperty('--style-question-font-size', `${styles.questionFontSize}px`)
  root.setProperty('--style-answer-bg', styles.answerBg)
  root.setProperty('--style-answer-font', styles.answerFont)
  root.setProperty('--style-answer-font-size', `${styles.answerFontSize}px`)
}
