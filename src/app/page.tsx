import React from 'react';
import type { Metadata } from 'next';
import WorkspaceShell from '@/components/workspace/WorkspaceShell';

export const metadata: Metadata = {
  title: 'MindForest',
  description: 'A visual knowledge organization tool.',
  icons: {
    icon: '/favicon.ico', 
  },
};

export default function Page() {
  return (
    // 1. Enforce "App-like" behavior (no window scrolling)
    <main className="h-screen w-screen overflow-hidden bg-forest-50">
      
      {/* 2. Mount the Interactive Client Layer */}
      <WorkspaceShell />
      
    </main>
  );
}