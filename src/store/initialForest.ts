import { ForestNode, NodeID } from '@/types/forest';

export const INITIAL_ROOT_ID: NodeID = 'root-1';

export const INITIAL_NODES: Record<NodeID, ForestNode> = {
  'root-1': {
    id: 'root-1',
    parentId: null,
    title: 'My MindForest',
    content: '# Welcome\nStart mapping your mind.',
    type: 'concept',
    children: ['child-1', 'child-2'],
    links: [],
    createdAt: Date.now(),
  },
  'child-1': {
    id: 'child-1',
    parentId: 'root-1',
    title: 'Design Patterns',
    content: '',
    type: 'concept',
    children: [],
    links: [],
    createdAt: Date.now(),
  },
  'child-2': {
    id: 'child-2',
    parentId: 'root-1',
    title: 'React Internals',
    content: '',
    type: 'concept',
    children: [],
    links: [],
    createdAt: Date.now(),
  }
};
