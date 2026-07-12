import { useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';
import { usePrivy } from '@privy-io/react-auth';
import { WaitlistModal } from '../components/WaitlistModal';
import { useAuth } from '../hooks';
import { useLandingScroll } from '../hooks/useLandingScroll';

const DEFAULT_HERO_VIDEO = '/assets/videos/DNA_helix_bg.mp4';

const FEATURES = [
  {
    eyebrow: 'Verifiable evidence',
    title: 'Grounded answers you can verify to the pixel',
    body: 'Every extracted claim links back to the exact passage, table, or figure in the source PDF. Claims are marked SUPPORTED or REFUTED, and clicking a citation highlights the evidence right next to the paper. No hand-waving — see exactly where each answer comes from.',
    image: '/images/landing/viewer.jpg',
    alt: 'CoralGPT provenance viewer showing a paper PDF beside an evidence panel of claims, each with a SUPPORTED badge',
    reverse: false,
  },
  {
    eyebrow: 'Grounded RAG',
    title: 'A paper library that talks back',
    body: 'Chat with any single paper and get answers grounded only in its content. Each card surfaces the evidence count, extracted facts, taxa, geography, and DOI at a glance — so you know what a paper contains before you open it.',
    image: '/images/landing/library.jpg',
    alt: 'CoralGPT paper library cards showing evidence pills, extracted fact counts, italic taxa chips, geography chips, and DOIs',
    reverse: true,
  },
  {
    eyebrow: 'Bioprospecting intelligence',
    title: 'Turn the literature into a discovery map',
    body: 'CoralGPT automatically extracts the organisms, compounds, and locations studied across the papers you feed it. The result is a living map of marine natural products — a head start for anyone prospecting reefs for new biology and chemistry.',
    image: '/images/landing/brain.jpg',
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
    q: 'Who can access the Test Agent?',
    a: 'Test Agent is available to whitelisted early-access users. Everyone else can join the waitlist to be notified when access expands.',
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

export function LandingPage() {
  useLandingScroll();
  const { login, authenticated, ready, getAccessToken } = usePrivy();
  const { exchangePrivyToken, isAuthenticated } = useAuth();
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [testingAgent, setTestingAgent] = useState(false);
  const [pendingLogin, setPendingLogin] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      route('/chat', true);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (pendingLogin && ready && authenticated) {
      handleExchange();
    }
  }, [pendingLogin, ready, authenticated]);

  const handleExchange = async () => {
    setTestingAgent(true);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setPendingLogin(false);
        return;
      }

      const result = await exchangePrivyToken(accessToken);
      if (result.whitelisted) {
        route('/chat', true);
      } else {
        route('/access-pending', true);
      }
    } finally {
      setTestingAgent(false);
      setPendingLogin(false);
    }
  };

  const handleTestAgent = async () => {
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
          <button type="button" className="btn-ghost" onClick={() => setWaitlistOpen(true)}>
            Join Waitlist
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
              className="btn-coral"
              onClick={handleTestAgent}
              disabled={testingAgent}
            >
              {testingAgent ? 'Connecting...' : 'Test Agent'}
            </button>
            <span className="landing-badge landing-badge--sm">
              Powered by $CRLAI
            </span>
          </div>
        </div>
      </section>

      <div className="landing-hero-shot-wrap">
        <figure className="landing-shot landing-hero-shot">
          <img
            src="/images/landing/library.jpg"
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
            <div key={step.num} className="landing-step">
              <div className="landing-step-num">{step.num}</div>
              <div className="landing-step-title">{step.title}</div>
              <div className="landing-step-body">{step.body}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <h2 className="landing-section-title">How the evidence works</h2>
        <p className="landing-section-lead">
          Built for a scientific audience — here is what stands behind every
          answer.
        </p>
        <div className="landing-trust">
          {TRUST.map((item) => (
            <div key={item.title} className="landing-trust-card">
              <div className="landing-trust-title">{item.title}</div>
              <div className="landing-trust-body">{item.body}</div>
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
            <a
              href="https://bioagents.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-teal-link"
            >
              Learn about $CRLAI
            </a>
            <a
              href="https://bioagents.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
            >
              View on BioAgents
            </a>
          </div>
        </div>
      </section>

      <section className="landing-section landing-section--band">
        <h2 className="landing-section-title">FAQ</h2>
        <div className="landing-faq">
          {FAQ.map((item, index) => (
            <div key={item.q} className="landing-faq-item">
              <button
                type="button"
                className="landing-faq-question"
                onClick={() => setOpenFaq(openFaq === index ? null : index)}
              >
                {item.q}
                <span>{openFaq === index ? '−' : '+'}</span>
              </button>
              {openFaq === index && (
                <div className="landing-faq-answer">{item.a}</div>
              )}
            </div>
          ))}
        </div>
      </section>

      <footer className="landing-footer">
        © 2026 CoralGPT · BioAgent powered by $CRLAI ·{' '}
        <a
          href="https://bioagents.xyz"
          target="_blank"
          rel="noopener noreferrer"
        >
          BioAgents
        </a>
      </footer>

      <WaitlistModal
        isOpen={waitlistOpen}
        onClose={() => setWaitlistOpen(false)}
        onTestAgent={() => {
          setWaitlistOpen(false);
          handleTestAgent();
        }}
      />
    </div>
  );
}
