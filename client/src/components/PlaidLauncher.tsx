import { useEffect } from 'react';
import { usePlaidLink } from 'react-plaid-link';

export interface LaunchState {
  token: string;
  mode: string; // 'new' | item id being re-linked
}

/**
 * Opens Plaid Link for the given launch token and reports the result. Shared by
 * Accounts (link / re-link) and Dashboard (re-link a card that lost auth).
 */
export function PlaidLauncher({
  launch,
  onDone,
}: {
  launch: LaunchState;
  onDone: (publicToken: string | null, institutionName: string | null) => void;
}) {
  const { open, ready } = usePlaidLink({
    token: launch.token,
    onSuccess: (publicToken, metadata) => onDone(publicToken, metadata.institution?.name ?? null),
    onExit: () => onDone(null, null),
  });

  useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  return <p className="info">Opening Plaid Link…</p>;
}
