import { useState } from "preact/hooks";
import { Icon } from "./icons";
import { BUTTON_ICON_CLASS } from "./ui/Button";
import { InlineCitationText } from "./InlineCitationText";

export function Message({ message }) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);

  // Format timestamp for display
  const formatTimestamp = (timestamp) => {
    if (!timestamp) return null;
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (isNaN(date.getTime())) return null;

    // Format: "12:34 PM" for today, "Dec 29, 12:34 PM" for other days
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    const timeStr = date.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    if (isToday) {
      return timeStr;
    }

    const dateStr = date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric'
    });
    return `${dateStr}, ${timeStr}`;
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return "";
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const getFileIcon = (mimeType) => {
    if (!mimeType) return "file";
    if (mimeType.includes("pdf")) return "file";
    if (mimeType.includes("image")) return "image";
    if (
      mimeType.includes("spreadsheet") ||
      mimeType.includes("excel") ||
      mimeType.includes("csv")
    )
      return "file";
    return "file";
  };

  const timestamp = formatTimestamp(message.timestamp);

  const renderContent = () => {
    if (isUser) {
      const files = message.files || [];
      const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
      const showCompact = files.length > 3;

      return (
        <div className="message-content-wrapper">
          {files.length > 0 && (
            <div className="message-files">
              {showCompact ? (
                // Compact view for many files
                <div
                  className="badge message-file-badge message-file-summary"
                  data-tone="brand"
                >
                  <Icon name="folder" size={14} />
                  <span className="file-name">
                    {files.length} files attached
                  </span>
                  <span className="file-size">
                    {formatFileSize(totalSize)}
                  </span>
                </div>
              ) : (
                // Show individual files when 3 or fewer
                files.map((file, index) => (
                  <div
                    key={index}
                    className="badge message-file-badge"
                    data-tone="brand"
                  >
                    <Icon name={getFileIcon(file.mimeType)} size={14} />
                    <span className="file-name">
                      {file.name || file.filename}
                    </span>
                    {file.size && (
                      <span className="file-size">
                        {formatFileSize(file.size)}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
          <div className="message-content">{message.content}</div>
          {timestamp && (
            <div className="message-timestamp">{timestamp}</div>
          )}
        </div>
      );
    } else {
      return (
        <div className="message-content-wrapper">
          {/* Use InlineCitationText component for citation support */}
          <InlineCitationText content={message.content} />

          <div className="message-footer">
            {timestamp && (
              <div className="message-timestamp">{timestamp}</div>
            )}
            <div className="message-actions">
            <button
              onClick={handleCopy}
              className="btn message-action-icon-btn"
              data-variant="ghost"
              data-size="icon"
              title="Copy"
            >
              <Icon name={copied ? "check" : "copy"} size={18} className={BUTTON_ICON_CLASS} />
            </button>
            <button
              disabled
              className="btn message-action-icon-btn"
              data-variant="ghost"
              data-size="icon"
              title="Like"
            >
              <Icon name="thumbsUp" size={18} className={BUTTON_ICON_CLASS} />
            </button>
            <button
              disabled
              className="btn message-action-icon-btn"
              data-variant="ghost"
              data-size="icon"
              title="Dislike"
            >
              <Icon name="thumbsDown" size={18} className={BUTTON_ICON_CLASS} />
            </button>
            <button
              disabled
              className="btn message-action-icon-btn"
              data-variant="ghost"
              data-size="icon"
              title="Share"
            >
              <Icon name="share" size={18} className={BUTTON_ICON_CLASS} />
            </button>
            <button
              disabled
              className="btn message-action-icon-btn"
              data-variant="ghost"
              data-size="icon"
              title="Regenerate"
            >
              <Icon name="refresh" size={18} className={BUTTON_ICON_CLASS} />
            </button>
            <button
              disabled
              className="btn message-action-icon-btn"
              data-variant="ghost"
              data-size="icon"
              title="More"
            >
              <Icon name="menu" size={18} className={BUTTON_ICON_CLASS} />
            </button>
            </div>
          </div>
        </div>
      );
    }
  };

  // Debug: log message to see if thinkingState is present
  if (!isUser && message.thinkingState) {
    console.log(
      "[Message] Rendering with thinkingState:",
      message.thinkingState,
    );
  } else if (!isUser) {
    console.log(
      "[Message] No thinkingState for assistant message:",
      message.id,
    );
  }

  // NO AVATAR HERE, AND THAT IS A DELETION, NOT AN OMISSION.
  //
  // This component used to render `<div class="avatar {user|assistant}">` with a
  // bot/user icon inside it. `global.css` set `.avatar { display: none }` — with
  // no override anywhere — so the element has NEVER been painted. It was dead
  // markup, and the rule that killed it was UNLAYERED, which meant it also beat
  // Basecoat's own `.avatar` component (Lyra puts it in `@layer components`) and
  // would have silently hidden any real avatar added anywhere in the app.
  //
  // Both are gone. The app's one REAL avatar — the account initial in the sidebar
  // footer — now wears Lyra's `.avatar`; see `Sidebar.jsx`.
  //
  // Turning this one back ON would be a redesign, not a migration: the chat is a
  // full-bleed 900px column with `gap: 0` and the user's bubble is right-aligned,
  // so a left-hand avatar has nowhere coherent to sit. That is a product decision
  // and it is not this slice's to take.
  return (
    <div className={`message ${isUser ? "user" : "assistant"}`}>
      <div className="message-content-container">{renderContent()}</div>
    </div>
  );
}
