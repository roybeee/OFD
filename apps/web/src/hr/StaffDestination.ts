import { useEffect, useRef } from 'react';

/** A navigation intent, never a mutation or a request for data outside the loaded workspace. */
export type StaffDestination = { recordId?: string; action?: 'create'; childId?: string };
export type StaffEntryIntent = StaffDestination & { nonce: string | number };

/** Consume each navigation once. Saving or refreshing the workspace must not reopen a closed form. */
export function useStaffEntryIntent(scope: string, intent: StaffEntryIntent | undefined, enter: (intent?: StaffEntryIntent) => void) {
  const previous = useRef('');
  const handler = useRef(enter);
  handler.current = enter;
  const key = JSON.stringify([scope, intent?.nonce, intent?.recordId, intent?.action, intent?.childId]);
  useEffect(() => {
    if (previous.current === key) return;
    previous.current = key;
    handler.current(intent);
  }, [key]);
}

export const unavailableStaffRecord = '요청한 항목을 찾을 수 없거나 조회 권한이 없습니다.';
