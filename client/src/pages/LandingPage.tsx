import { useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';
import { usePrivy } from '@privy-io/react-auth';
import { WaitlistModal } from '../components/WaitlistModal';
import { useAuth } from '../hooks';
import { useLandingScroll } from '../hooks/useLandingScroll';

const DEFAULT_HERO_VIDEO =
  'https://videos.pexels.com/video-files/854982/854982-hd_1920_1080_30fps.mp4';

const STEPS = [
  {
    num: '01',
    title: 'Ask',
    body: 'Pose a research question about coral reefs, bleaching events, symbionts, or restoration.',
  },
  {
    num: '02',
    title: 'Research',
    body: 'CoralGPT searches scientific literature and synthesizes findings from peer-reviewed sources.',
  },
  {
    num: '03',
    title: 'Analyze',
    body: 'Upload datasets or connect analysis tasks to validate hypotheses with real data.',
  },
  {
    num: '04',
    title: 'Discover',
    body: 'Get novel, evidence-linked claims you can trace back to papers and analysis jobs.',
  },
];

const TOPICS = [
  'Coral bleaching and thermal stress response',
  'Symbiodiniaceae symbiont dynamics',
  '13C metabolomics and carbon fate during bleaching',
  'Reef restoration and assisted evolution strategies',
  'Climate impact modeling and conservation policy',
];

const FAQ = [
  {
    q: 'What is CoralGPT?',
    a: 'CoralGPT is a specialized AI research agent focused on coral reef science. It combines literature search, data analysis, and hypothesis generation into one iterative workflow.',
  },
  {
    q: 'Who can access the Test Agent?',
    a: 'Test Agent is available to whitelisted early-access users. Everyone else can join the waitlist to be notified when access expands.',
  },
  {
    q: 'What is $CRLAI?',
    a: '$CRLAI is the token that powers the CoralGPT agent network, aligning incentives between researchers and the BioAgents infrastructure.',
  },
  {
    q: 'How does Deep Research work?',
    a: 'Deep Research runs multi-step investigation cycles: planning, literature and analysis tasks, hypothesis, reflection, and discovery. Each cycle builds on accumulated knowledge.',
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
          <img src="/images/token.png" alt="CoralGPT" width={32} height={32} />
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
          <h1 className="landing-hero-title">The AI Scientist for Coral Reefs</h1>
          <p className="landing-hero-subtitle">
            Ask questions, run deep research, and discover evidence-backed insights
            about coral health, bleaching, and restoration.
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
            <span className="landing-badge">BioAgent powered by $CRLAI</span>
          </div>
        </div>
      </section>

      <section className="landing-section">
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
        <h2 className="landing-section-title">Built for Coral Science</h2>
        <div className="landing-topics">
          {TOPICS.map((topic) => (
            <div key={topic} className="landing-topic">
              {topic}
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-token-card">
          <h3>Powered by BioAgents + $CRLAI</h3>
          <p>
            CoralGPT runs on the BioAgents research framework — an iterative,
            hypothesis-driven AI scientist that builds knowledge across every
            research cycle. $CRLAI aligns incentives between researchers, data
            contributors, and the agent network that powers discovery.
          </p>
          <div className="landing-token-actions">
            <a href="#" className="btn-teal-link">
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

      <section className="landing-section">
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
        <a href="#">Privacy</a> · <a href="#">Terms</a>
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
