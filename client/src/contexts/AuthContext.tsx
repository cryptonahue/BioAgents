import { createContext } from 'preact';
import { useContext, useState, useEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

const AUTH_TOKEN_KEY = 'bioagents_auth_token';
const USER_EMAIL_KEY = 'bioagents_user_email';

interface AuthContextType {
  isAuthenticated: boolean;
  isAuthRequired: boolean;
  isChecking: boolean;
  isLoggingOut: boolean;
  coralGptEnabled: boolean;
  privyAppId: string | null;
  token: string | null;
  userId: string | null;
  userEmail: string | null;
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  exchangePrivyToken: (accessToken: string) => Promise<{ whitelisted: boolean }>;
  getAuthToken: () => string | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function getStoredEmail(): string | null {
  try {
    return localStorage.getItem(USER_EMAIL_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch (error) {
    console.error('Failed to store auth token:', error);
  }
}

function storeEmail(email: string): void {
  try {
    localStorage.setItem(USER_EMAIL_KEY, email);
  } catch (error) {
    console.error('Failed to store user email:', error);
  }
}

function clearStoredToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(USER_EMAIL_KEY);
  } catch (error) {
    console.error('Failed to clear auth token:', error);
  }
}

function decodeJWTPayload(token: string): { sub?: string; email?: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ComponentChildren }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthRequired, setIsAuthRequired] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [coralGptEnabled, setCoralGptEnabled] = useState(false);
  const [privyAppId, setPrivyAppId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(getStoredToken());
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(getStoredEmail());

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const storedToken = getStoredToken();
      const headers: Record<string, string> = {};

      if (storedToken) {
        headers['Authorization'] = `Bearer ${storedToken}`;
      }

      const response = await fetch('/api/auth/status', { headers });

      if (response.ok) {
        const data = await response.json();
        setCoralGptEnabled(data.coralGptEnabled === true);
        setPrivyAppId(data.privyAppId || null);
        setIsAuthRequired(data.isAuthRequired);
        setIsAuthenticated(data.isAuthenticated);

        if (data.userId) {
          setUserId(data.userId);
        } else if (storedToken) {
          const payload = decodeJWTPayload(storedToken);
          if (payload?.sub) {
            setUserId(payload.sub);
          }
          if (payload?.email) {
            setUserEmail(payload.email);
          }
        }

        if (!data.isAuthenticated && storedToken) {
          clearStoredToken();
          setToken(null);
          setUserId(null);
          setUserEmail(null);
        }
      }
    } catch (error) {
      console.error('Failed to check auth status:', error);
      setIsAuthenticated(false);
      setIsAuthRequired(false);
    } finally {
      setIsChecking(false);
    }
  };

  const login = async (password: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          if (data.token) {
            storeToken(data.token);
            setToken(data.token);
            const payload = decodeJWTPayload(data.token);
            if (payload?.sub) {
              setUserId(payload.sub);
            }
          }
          setIsAuthenticated(true);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('Login failed:', error);
      return false;
    }
  };

  const exchangePrivyToken = async (
    accessToken: string,
  ): Promise<{ whitelisted: boolean }> => {
    const response = await fetch('/api/auth/privy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    });

    const data = await response.json();

    if (response.ok && data.success && data.token) {
      storeToken(data.token);
      setToken(data.token);
      setUserId(data.userId);
      setIsAuthenticated(true);

      if (data.email) {
        storeEmail(data.email);
        setUserEmail(data.email);
      }

      return { whitelisted: true };
    }

    if (data.email) {
      setUserEmail(data.email);
    }

    return { whitelisted: false };
  };

  const logout = async (): Promise<void> => {
    setIsLoggingOut(true);

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Logout request failed:', error);
    }

    clearStoredToken();
    setToken(null);
    setUserId(null);
    setUserEmail(null);
    setIsAuthenticated(false);
    setIsLoggingOut(false);
  };

  const getAuthToken = (): string | null => {
    return token || getStoredToken();
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isAuthRequired,
        isChecking,
        isLoggingOut,
        coralGptEnabled,
        privyAppId,
        token,
        userId,
        userEmail,
        login,
        logout,
        exchangePrivyToken,
        getAuthToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
}

export function getAuthTokenFromStorage(): string | null {
  return getStoredToken();
}
