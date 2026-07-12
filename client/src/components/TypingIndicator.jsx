export function TypingIndicator() {
  // The `.avatar` div this used to render was `display: none` in `global.css` and
  // had never been painted. It is gone, with the rule that hid it. See the note in
  // `Message.jsx`.
  return (
    <div className="message assistant">
      <div className="message-content">
        <div className="typing-indicator">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
  );
}
