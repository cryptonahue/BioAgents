import { useEffect } from 'preact/hooks';

/** Unlock page scroll on marketing/landing routes (chat UI uses body overflow:hidden). */
export function useLandingScroll() {
  useEffect(() => {
    document.documentElement.classList.add('coralgpt-scroll');
    document.body.classList.add('coralgpt-scroll');

    return () => {
      document.documentElement.classList.remove('coralgpt-scroll');
      document.body.classList.remove('coralgpt-scroll');
    };
  }, []);
}
