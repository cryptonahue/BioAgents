import { useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';
import { usePrivy } from '@privy-io/react-auth';
import { ExternalLink } from '../utils/externalLinks';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuth } from '../hooks';
import { useLandingScroll } from '../hooks/useLandingScroll';

const DEFAULT_HERO_VIDEO = '/assets/videos/DNA_helix_bg.mp4';

const FEATURES = [
  {
    eyebrow: 'Verifiable evidence',
    title: 'Grounded answers you can verify to the pixel',
    body: 'Every extracted claim links back to the exact passage, table, or figure in the source PDF. Claims are marked SUPPORTED or REFUTED, and clicking a citation highlights the evidence right next to the paper. No hand-waving — see exactly where each answer comes from.',
    image: '/images/landing/provenance-viewer.jpg',
    alt: 'CoralGPT provenance viewer showing a paper PDF beside an evidence panel of claims, each with a SUPPORTED badge',
    reverse: false,
  },
  {
    eyebrow: 'Grounded RAG',
    title: 'A paper library that talks back',
    body: 'Chat with any single paper and get answers grounded only in its content. Each card surfaces the evidence count, extracted facts, taxa, geography, and DOI at a glance — so you know what a paper contains before you open it.',
    image: '/images/landing/paper-library.jpg',
    alt: 'CoralGPT paper library cards showing evidence pills, extracted fact counts, italic taxa chips, geography chips, and DOIs',
    reverse: true,
  },
  {
    eyebrow: 'Bioprospecting intelligence',
    title: 'Turn the literature into a discovery map',
    body: 'CoralGPT automatically extracts the organisms, compounds, and locations studied across the papers you feed it. The result is a living map of marine natural products — a head start for anyone prospecting reefs for new biology and chemistry.',
    image: '/images/landing/research-brain.jpg',
    alt: 'CoralGPT research brain page mapping organisms, compounds, and geographies extracted from the literature',
    reverse: false,
  },
];

const STEPS = [
  {
    num: '01',
    title: 'Ask',
    body: 'Pose a research question about coral reefs, bleaching, symbionts, or restoration — CoralGPT plans the investigation.',
  },
  {
    num: '02',
    title: 'Research',
    body: 'It searches peer-reviewed literature and synthesizes findings, linking every claim back to its source passage.',
  },
  {
    num: '03',
    title: 'Analyze',
    body: 'Connect datasets and analysis tasks to test hypotheses against real data, not just prose.',
  },
  {
    num: '04',
    title: 'Discover',
    body: 'Each iterative cycle builds on the last, surfacing novel, evidence-linked claims you can trace to papers and jobs.',
  },
];

const TRUST = [
  {
    title: 'Peer-reviewed sources',
    body: 'The corpus is built from published, peer-reviewed papers — not scraped web text or model memory.',
  },
  {
    title: 'An extraction pipeline',
    body: 'Each paper is parsed into structured claims and facts — taxa, compounds, geography, and measurements.',
  },
  {
    title: 'Provenance on every claim',
    body: 'Each claim keeps a link back to the exact location in the source PDF, so nothing is a black box.',
  },
  {
    title: 'Trust tiers',
    body: 'Sources are ranked by quality, so stronger evidence carries more weight in the answers you get.',
  },
];

const AUDIENCE = [
  {
    title: 'Reef scientists',
    body: 'Coral biologists, ecologists, and microbiologists who need answers they can cite — and check — rather than a confident summary of nothing in particular.',
  },
  {
    title: 'Bioprospectors',
    body: 'Anyone hunting marine natural products, who wants the organisms, compounds, and locations already extracted from the literature instead of read out of it by hand.',
  },
  {
    title: 'Conservation teams',
    body: 'Restoration and policy work that has to stand on evidence, with every claim traceable back to the paper it came from.',
  },
];

const FAQ = [
  {
    q: 'What is CoralGPT?',
    a: 'CoralGPT is a specialized AI research agent for coral reef science. It combines a grounded paper library, an evidence viewer, and iterative deep research into one workflow — and every answer traces back to the source.',
  },
  {
    q: 'How can I trust the answers?',
    a: 'Every extracted claim links to the exact passage, table, or figure in the original PDF and is marked SUPPORTED or REFUTED. You can open the provenance viewer and check the evidence yourself, to the pixel.',
  },
  {
    q: 'Why is access limited?',
    a: 'CoralGPT is in private beta. Every answer is grounded in a curated corpus of peer-reviewed papers, and each research cycle runs real literature and analysis work — so we grow the user base deliberately, keeping the corpus and the answers good rather than opening the doors and degrading both. Access is approved individually.',
  },
  {
    q: 'How long does approval take?',
    a: 'We review requests by hand, usually within a few days. Sign in, tell us who you are and what you would use CoralGPT for, and we will email you as soon as your access is ready. You do not need to do anything else in the meantime.',
  },
  {
    q: 'How does Deep Research work?',
    a: 'Deep Research runs multi-step cycles: planning, literature and analysis tasks, hypothesis, reflection, and discovery. Each cycle builds on accumulated knowledge instead of treating your question in isolation.',
  },
];

const heroVideoUrl =
  (typeof import.meta !== 'undefined' &&
    (import.meta as any).env?.CORALGPT_HERO_VIDEO_URL) ||
  DEFAULT_HERO_VIDEO;

/**
 * ONE DOOR.
 *
 * There used to be two entry points that promised different things and delivered
 * the same nothing: a hero CTA reading "Test Agent" — which ran Privy, created a
 * user with `access_type = null`, and returned 403 "Access pending approval", a
 * broken promise on the very first click — and a "Join Waitlist" form that wrote
 * to a table NOTHING read.
 *
 * Both are gone. There is now one CTA, "Get started", in the hero and in the
 * header. It runs Privy, and THE SYSTEM DECIDES WHAT YOU SEE: whitelisted users
 * land in `/chat`, everyone else lands on `/access-pending`, which is now the
 * request form (prefilled from the Privy identity) or the "under review" notice.
 *
 * There is deliberately no separate "Sign in" button. After Privy resolves, the
 * system already knows your state — asking the user to self-select between "sign
 * in" and "request access" would be asking them to guess it for us.
 *
 * The beta is declared as CLOSED before auth (the line under the CTA), so the
 * click is not a surprise. NO COUNTER — the queue size is deliberately not shown.
 */
export function LandingPage() {
  useLandingScroll();
  const { login, authenticated, ready, getAccessToken } = usePrivy();
  const { exchangePrivyToken, isAuthenticated } = useAuth();
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [pendingLogin, setPendingLogin] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      route('/chat', true);
    }
  }, [isAuthenticated]);

  // Privy session restored (or login just finished): exchange for our JWT
  // without forcing another click on "Get started".
  useEffect(() => {
    if (!ready || !authenticated || isAuthenticated || connecting) return;
    // pendingLogin covers the post-login() path; the bare authenticated
    // branch covers a returning session after refresh / reopen.
    handleExchange();
  }, [pendingLogin, ready, authenticated, isAuthenticated, connecting]);

  const handleExchange = async () => {
    setConnecting(true);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setPendingLogin(false);
        return;
      }

      // Whitelisted -> the app. Everyone else -> the request form / the notice.
      // `/access-pending` re-asks the server for its own state, so it does not
      // matter that we do not forward `hasRequest` here.
      const result = await exchangePrivyToken(accessToken);
      route(result.whitelisted ? '/chat' : '/access-pending', true);
    } finally {
      setConnecting(false);
      setPendingLogin(false);
    }
  };

  const handleGetStarted = async () => {
    if (isAuthenticated) {
      route('/chat', true);
      return;
    }

    if (authenticated && ready) {
      await handleExchange();
      return;
    }

    setPendingLogin(true);
    login();
  };

  return (
    <div className="landing-page">
      <header className="landing-header">
        <a href="/" className="landing-brand">
          <img
            src="/images/coralgpt.png"
            alt="CoralGPT"
            className="landing-brand-img"
          />
          <span className="landing-brand-text">
            <span className="coral">CORAL</span>
            <span className="gpt">GPT</span>
          </span>
        </a>
        <div className="landing-nav-actions">
          {/* The ONE door, again. Not a second, different promise. */}
          <button
            type="button"
            className="btn btn-marketing"
            data-variant="outline"
            onClick={handleGetStarted}
            disabled={connecting}
          >
            {connecting ? 'Connecting...' : 'Get started'}
          </button>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-video-wrap">
          <video
            className="landing-hero-video"
            autoPlay
            muted
            loop
            playsInline
            poster="/images/welcome-background.png"
          >
            <source src={heroVideoUrl} type="video/mp4" />
          </video>
          <div className="landing-hero-overlay" />
        </div>
        <div className="landing-hero-content">
          <h1 className="landing-hero-title">
            The AI scientist for coral reefs that shows its work
          </h1>
          <p className="landing-hero-subtitle">
            Ask about coral health, bleaching, and restoration — and get answers
            grounded in peer-reviewed papers, each claim traced to the exact
            evidence. Plus a bioprospecting map of the organisms and compounds
            hiding in the literature.
          </p>
          <div className="landing-hero-actions">
            <button
              type="button"
              className="btn btn-marketing"
              data-variant="outline"
              data-tone="coral"
              data-size="lg"
              onClick={handleGetStarted}
              disabled={connecting}
            >
              {connecting ? 'Connecting...' : 'Get started'}
            </button>
            {/* `data-tone` MUST carry an explicit `data-variant`: Lyra's default
                is `.btn:not([data-variant])` -> the teal primary fill, at a
                specificity the tone's own hover cannot beat. See buttons.css. */}
            <span className="badge" data-tone="teal">
              Powered by $CRLAI
            </span>
          </div>
          {/* The beta is declared CLOSED before the click, so "Get started" is
              not the broken promise "Test Agent" was. NO COUNTER — the queue
              size is deliberately not shown. */}
          <p className="landing-hero-gate">
            Private beta — we approve researchers individually.
          </p>
        </div>
      </section>

      <div className="landing-hero-shot-wrap">
        <figure className="landing-shot landing-hero-shot">
          <img
            src="/images/landing/paper-library.jpg"
            alt="CoralGPT paper library showing evidence pills, extracted fact counts, taxa and geography chips, and DOIs on each paper card"
            loading="lazy"
          />
        </figure>
      </div>

      <section className="landing-section">
        <h2 className="landing-section-title">See the evidence</h2>
        <p className="landing-section-lead">
          This isn&apos;t a chatbot that sounds confident. It&apos;s a research
          tool that hands you the receipts.
        </p>
        <div className="landing-features">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className={
                'landing-feature' +
                (feature.reverse ? ' landing-feature--reverse' : '')
              }
            >
              <div className="landing-feature-media">
                <figure className="landing-shot">
                  <img src={feature.image} alt={feature.alt} loading="lazy" />
                </figure>
              </div>
              <div className="landing-feature-text">
                <span className="landing-feature-eyebrow">
                  {feature.eyebrow}
                </span>
                <h3 className="landing-feature-title">{feature.title}</h3>
                <p className="landing-feature-body">{feature.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section landing-section--band">
        <h2 className="landing-section-title">How It Works</h2>
        <div className="landing-steps">
          {STEPS.map((step) => (
            <div key={step.num} className="card landing-card">
              <section>
                <div className="landing-step-num">{step.num}</div>
                <h3 className="landing-step-title">{step.title}</h3>
                <p className="landing-step-body">{step.body}</p>
              </section>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <h2 className="landing-section-title">Who this is for</h2>
        <p className="landing-section-lead">
          Access is approved individually, so it helps to know who we build for.
        </p>
        <div className="landing-trust">
          {AUDIENCE.map((item) => (
            <div key={item.title} className="card landing-card">
              <section>
                <h3 className="landing-trust-title">{item.title}</h3>
                <p className="landing-trust-body">{item.body}</p>
              </section>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section landing-section--band">
        <h2 className="landing-section-title">How the evidence works</h2>
        <p className="landing-section-lead">
          Built for a scientific audience — here is what stands behind every
          answer.
        </p>
        <div className="landing-trust">
          {TRUST.map((item) => (
            <div key={item.title} className="card landing-card">
              <section>
                <h3 className="landing-trust-title">{item.title}</h3>
                <p className="landing-trust-body">{item.body}</p>
              </section>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section landing-section--token">
        <div className="landing-token-card landing-token-card--muted">
          <h3>Powered by BioAgents + $CRLAI</h3>
          <p>
            CoralGPT runs on the BioAgents research framework — an iterative,
            hypothesis-driven AI scientist. $CRLAI aligns incentives between
            researchers, data contributors, and the agent network behind it.
          </p>
          <div className="landing-token-actions">
            <ExternalLink
              href="https://bioagents.xyz"
              className="btn btn-marketing"
              data-variant="outline"
              data-tone="teal"
              label="Learn about $CRLAI on bioagents.xyz"
            >
              Learn about $CRLAI
            </ExternalLink>

          </div>
        </div>
      </section>

      <section className="landing-section landing-section--band">
        <h2 className="landing-section-title">FAQ</h2>
        {/*
          Basecoat's `.accordion`, which is written against native <details> /
          <summary> — so the disclosure role, the expanded state, Enter/Space and
          the open/close all come from the browser rather than from ARIA this app
          would have to keep honest. The markup this replaces was a <button> with
          no `aria-expanded` and no `aria-controls`: it announced nothing.

          `accordion.js` is not loaded (no Basecoat JS is). The only thing it adds
          over the native element is single-open exclusivity, and Preact already
          owns that: `openFaq` drives `open`, and `preventDefault()` on the summary
          hands the browser's default toggle back to us. Activating a <summary>
          dispatches a click, so this catches the keyboard too.

          The chevron must be the LAST child of the <summary>: Lyra selects it as
          `summary > svg:last-child` and rotates it on `details[open]`.
        */}
        <div className="accordion landing-faq">
          {FAQ.map((item, index) => (
            <details key={item.q} open={openFaq === index}>
              <summary
                onClick={(e) => {
                  e.preventDefault();
                  setOpenFaq(openFaq === index ? null : index);
                }}
              >
                {item.q}
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </summary>
              <div className="landing-faq-answer">{item.a}</div>
            </details>
          ))}
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-legal">
          © 2026 CoralGPT · BioAgent powered by $CRLAI ·{' '}
          <ExternalLink
            href="https://github.com/MesoReefDAO/BioAgents"
            label="GitHub"
          >
            GitHub
          </ExternalLink>
        </div>
        {/* The toggle only became meaningful once the pin was narrowed off the
            page root — before that it would have flipped the rest of the app
            while the landing stayed frozen dark. It carries its own aria-label
            (naming the ACTION, not the state) and the house focus ring, both
            from ThemeToggle.
            Hidden while light mode is disabled (dark-only); see
            LIGHT_MODE_ENABLED in contexts/ThemeContext.tsx. */}
        {/* <ThemeToggle /> */}
      </footer>
    </div>
  );
}
