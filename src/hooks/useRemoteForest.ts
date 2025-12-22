'use client';

import { useEffect } from 'react';

import { useForestDataStore } from '@/store/useForestDataStore';
import { useWorkspaceUIStore } from '@/store/useWorkspaceUIStore';

/**
 * Hydrates the local store from the Rust API when NEXT_PUBLIC_REMOTE_TOPIC_ID is set.
 * Keeps the UI focus aligned to the remote root node.
 */
export function useRemoteForestBootstrap() {
  const ensureRemoteTopic = useForestDataStore((s) => s.ensureRemoteTopic);
  const setFocus = useWorkspaceUIStore((s) => s.setFocus);

  useEffect(() => {
    ensureRemoteTopic().then((rootId) => {
      if (rootId) {
        setFocus(rootId);
      }
    });
  }, [ensureRemoteTopic, setFocus]);
}
