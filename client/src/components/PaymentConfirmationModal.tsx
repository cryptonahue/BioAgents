import { Modal } from "./ui/Modal";

interface PaymentConfirmationModalProps {
  isOpen: boolean;
  amount: string;
  currency: string;
  network: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Presentation lives in `styles/wallet.css` (`.payment-modal*`). See the header
 * of that file for the literal-to-token mapping this component went through.
 */
export function PaymentConfirmationModal({
  isOpen,
  amount,
  currency,
  network,
  onConfirm,
  onCancel,
}: PaymentConfirmationModalProps) {
  const isTestnet = network.includes("sepolia");

  return (
    <Modal isOpen={isOpen} onClose={onCancel} maxWidth="450px">
      <div className="payment-modal">
        <div className="payment-modal__header">
          <div className="wallet-panel__badge wallet-panel__badge--square">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M12 6v6l4 2"></path>
            </svg>
          </div>
          <h2 className="payment-modal__title">Confirm Payment</h2>
          <p className="payment-modal__subtitle">
            Please review the transaction details before proceeding
          </p>
        </div>

        <div className="payment-modal__details">
          <div className="payment-modal__amount-label">Amount</div>
          <div className="payment-modal__amount">
            ${amount} {currency}
          </div>

          <div className="payment-modal__rows">
            <div className="payment-modal__row">
              <span className="payment-modal__row-key">Network</span>
              <span className="payment-modal__row-value payment-modal__row-value--mono">
                {network === "base-sepolia" ? "Base Sepolia" : "Base"}
              </span>
            </div>
            <div className="payment-modal__row">
              <span className="payment-modal__row-key">Type</span>
              <span className="payment-modal__row-value">Gasless Transfer (EIP-3009)</span>
            </div>
          </div>

          {isTestnet && (
            <div className="payment-modal__testnet">
              ⚠️ Testnet Transaction - No real funds will be used
            </div>
          )}
        </div>

        <div className="payment-modal__actions">
          <button type="button" onClick={onCancel} className="wallet-btn wallet-btn--secondary">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="wallet-btn wallet-btn--primary">
            Confirm Payment
          </button>
        </div>
      </div>
    </Modal>
  );
}
