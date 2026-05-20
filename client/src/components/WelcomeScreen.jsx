import { Icon } from './icons/Icon';

export function WelcomeScreen({ onExampleClick, coralGptMode = false }) {
  const examples = coralGptMode
    ? [
        {
          icon: 'activity',
          title: 'Bleaching',
          text: 'What are the latest findings on coral bleaching mechanisms under thermal stress?',
        },
        {
          icon: 'microscope',
          title: 'Symbionts',
          text: 'Explain Symbiodiniaceae diversity and its role in coral resilience',
        },
        {
          icon: 'flask',
          title: 'Metabolomics',
          text: 'How does 13C metabolomics reveal carbon fate during coral bleaching?',
        },
        {
          icon: 'dna',
          title: 'Restoration',
          text: 'What restoration strategies show the most promise for degraded reefs?',
        },
        {
          icon: 'activity',
          title: 'Climate',
          text: 'How do ocean acidification and warming interact to affect coral calcification?',
        },
        {
          icon: 'pill',
          title: 'Policy',
          text: 'Summarize recent policy frameworks for coral reef conservation',
        },
      ]
    : [
        {
          icon: 'dna',
          title: 'Gene Editing',
          text: 'What are the latest findings on CRISPR gene editing?',
        },
        {
          icon: 'microscope',
          title: 'Protein Biology',
          text: 'Explain protein folding mechanisms',
        },
        {
          icon: 'activity',
          title: 'Cancer Research',
          text: 'Search for papers on cancer immunotherapy',
        },
        {
          icon: 'syringe',
          title: 'Vaccine Technology',
          text: 'How does mRNA vaccine technology work?',
        },
        {
          icon: 'pill',
          title: 'Drug Discovery',
          text: 'Find recent breakthroughs in AI-driven drug discovery',
        },
        {
          icon: 'flask',
          title: 'Genomics',
          text: 'What are the applications of single-cell sequencing?',
        },
      ];

  return (
    <div className="welcome-screen">
      <div
        className="welcome-screen-backdrop"
        aria-hidden="true"
        style={{ backgroundImage: "url('/images/welcome-background.png')" }}
      />
      <div className="welcome-screen-overlay" aria-hidden="true" />
      <div className="welcome-screen-content">
        <div className="welcome-header">
          <div className="welcome-logo-icon">
            <img
              src="/images/token.png"
              alt={coralGptMode ? 'CoralGPT' : 'BioAgents'}
              width={48}
              height={48}
              decoding="async"
            />
          </div>
          {coralGptMode ? (
            <>
              <h1 className="welcome-title">
                <span className="welcome-title-bio">CORAL</span>
                <span className="welcome-title-agents">GPT</span>
              </h1>
              <p className="welcome-subtitle">
                AI scientist for coral reef research
              </p>
              <p className="welcome-subtitle" style={{ marginTop: '4px', fontSize: '13px', color: '#2dd4bf' }}>
                BioAgent powered by $CRLAI
              </p>
            </>
          ) : (
            <>
              <h1 className="welcome-title">
                <span className="welcome-title-bio">BIO</span>
                <span className="welcome-title-agents">AGENTS</span>
              </h1>
              <p className="welcome-subtitle">
                AI-powered biological research assistant
              </p>
            </>
          )}
        </div>

        <div className="welcome-section">
          <h2 className="welcome-section-title">
            {coralGptMode ? 'Research Topics' : 'Popular Topics'}
          </h2>
          <div className="example-prompts">
            {examples.map((example, index) => (
              <div
                key={index}
                className="example-prompt"
                onClick={() => onExampleClick && onExampleClick(example.text)}
              >
                <div className="example-prompt-icon">
                  <Icon name={example.icon} size={20} />
                </div>
                <div className="example-prompt-content">
                  <div className="example-prompt-title">{example.title}</div>
                  <div className="example-prompt-text">{example.text}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
