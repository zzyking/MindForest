import { beforeEach, describe, expect, it } from 'vitest';

import { useForestDataStore } from '../useForestDataStore';
import { INITIAL_NODES, INITIAL_ROOT_ID } from '../initialForest';

const cloneNodes = () => JSON.parse(JSON.stringify(INITIAL_NODES));

describe('useForestDataStore', () => {
  beforeEach(() => {
    useForestDataStore.setState({
      nodes: cloneNodes(),
      rootNodeId: INITIAL_ROOT_ID
    });
  });

  it('adds child nodes and links them to the parent', () => {
    const { addNode } = useForestDataStore.getState();
    const createdId = addNode(INITIAL_ROOT_ID, 'New Idea');
    const state = useForestDataStore.getState();

    expect(createdId).toBeTruthy();
    expect(state.nodes[createdId!]).toBeDefined();
    expect(state.nodes[createdId!].parentId).toBe(INITIAL_ROOT_ID);
    expect(state.nodes[INITIAL_ROOT_ID].children).toContain(createdId);
  });

  it('updates node title and content', () => {
    const { updateNodeTitle, updateNodeContent } = useForestDataStore.getState();
    updateNodeTitle(INITIAL_ROOT_ID, 'Renamed Root');
    updateNodeContent(INITIAL_ROOT_ID, 'Body copy');

    const state = useForestDataStore.getState();
    expect(state.nodes[INITIAL_ROOT_ID].title).toBe('Renamed Root');
    expect(state.nodes[INITIAL_ROOT_ID].content).toBe('Body copy');
  });

  it('creates and removes bidirectional links', () => {
    const { linkNodes, unlinkNodes } = useForestDataStore.getState();
    const childId = useForestDataStore.getState().nodes[INITIAL_ROOT_ID].children[0];

    linkNodes(INITIAL_ROOT_ID, childId);
    let state = useForestDataStore.getState();
    expect(state.nodes[INITIAL_ROOT_ID].links).toContain(childId);
    expect(state.nodes[childId].links).toContain(INITIAL_ROOT_ID);

    unlinkNodes(INITIAL_ROOT_ID, childId);
    state = useForestDataStore.getState();
    expect(state.nodes[INITIAL_ROOT_ID].links).not.toContain(childId);
    expect(state.nodes[childId].links).not.toContain(INITIAL_ROOT_ID);
  });

  it('deletes a subtree and clears references', () => {
    const store = useForestDataStore.getState();
    const extraId = store.addNode(INITIAL_ROOT_ID, 'Extra')!;
    store.linkNodes(extraId, 'child-1');

    const nextFocus = store.deleteNode('child-1');
    const state = useForestDataStore.getState();

    expect(state.nodes['child-1']).toBeUndefined();
    expect(state.nodes[INITIAL_ROOT_ID].children).not.toContain('child-1');
    expect(state.nodes[extraId].links).not.toContain('child-1');
    expect(nextFocus).toBe(INITIAL_ROOT_ID);
  });
});
