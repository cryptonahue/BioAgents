-- Waitlist leads for CoralGPT early access capture
CREATE TABLE IF NOT EXISTS public.waitlist_leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name text NOT NULL,
    email text NOT NULL,
    wallet_address text,
    role text NOT NULL,
    organization text,
    use_case text NOT NULL,
    referral_source text,
    twitter_handle text,
    agreed_to_updates boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_leads_email_lower_idx
    ON public.waitlist_leads (lower(email));

COMMENT ON TABLE public.waitlist_leads IS 'CoralGPT waitlist signups for early access and market research';

GRANT ALL ON TABLE public.waitlist_leads TO service_role;
