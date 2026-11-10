import { useEffect, useState } from 'react';
import { engineLabel, getEngineStatus, type EngineStatus, type Invoke } from './engine';

export function EngineBadge({ invoke }: { invoke: Invoke | null }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    let live = true;
    void getEngineStatus(invoke).then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [invoke]);

  const stopped = status?.state === 'stopped';
  return (
    <div className={`engine-badge${stopped ? ' engine-stopped' : ''}`} role="status" title={stopped ? status.reason : undefined}>
      {engineLabel(status)}
    </div>
  );
}
