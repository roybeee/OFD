import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, loadBootstrap, logoutV2, registerStepUpRequester, stepUpV2 } from './api/client';
import { createStepUpCoordinator } from './api/step-up-coordinator';
import { LoginScreen, StepUpDialog, UnauthorizedScreen } from './components/AuthGate';
import { AppShell } from './components/AppShell';
import { ApiConnectionError, Button, SkeletonScreen, ToastRegion } from './components/ui';
import { DriverTodayPage } from './pages/DriverTodayPage';
import { HqDeliveryPage } from './pages/HqDeliveryPage';
import { HqInvoicesPage } from './pages/HqInvoicesPage';
import { HqAccountsPage } from './pages/HqAccountsPage';
import { HqOrdersPage } from './pages/HqOrdersPage';
import { HqReconciliationPage } from './pages/HqReconciliationPage';
import { StoreDocumentsPage } from './pages/StoreDocumentsPage';
import { StoreOrdersPage } from './pages/StoreOrdersPage';
import type { BootstrapData, PublicActor, Toast } from './types';
import { browserPathFor, canAccessPath, defaultPathFor, logicalPathFromLocation, roleForPath } from './lib/access';

const knownPaths = new Set(['/store/orders', '/store/documents', '/hq/orders', '/hq/delivery', '/hq/reconciliation', '/hq/invoices', '/hq/accounts', '/driver/today', '/unauthorized']);

function initialPath() {
  const logicalPath = logicalPathFromLocation(window.location.pathname, import.meta.env.BASE_URL);
  if (knownPaths.has(logicalPath)) return logicalPath;
  const params = new URLSearchParams(window.location.search);
  const role = params.get('role');
  const view = params.get('view');
  if (role === 'hq') return view === 'delivery' ? '/hq/delivery' : view === 'reconciliation' ? '/hq/reconciliation' : view === 'invoices' ? '/hq/invoices' : '/hq/orders';
  if (role === 'driver') return '/driver/today';
  return view === 'documents' ? '/store/documents' : '/store/orders';
}

export default function App() {
  const [path, setPath] = useState(initialPath);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [authorizationDenied, setAuthorizationDenied] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [logoutPending, setLogoutPending] = useState(false);
  const postLoginRedirect = useRef(false);
  const stepUpCoordinator = useRef<ReturnType<typeof createStepUpCoordinator> | null>(null);
  if (!stepUpCoordinator.current) {
    stepUpCoordinator.current = createStepUpCoordinator(() => setStepUpOpen(true), () => setStepUpOpen(false));
  }
  const role = roleForPath(path);

  useEffect(() => {
    const coordinator = stepUpCoordinator.current!;
    registerStepUpRequester(() => coordinator.request());
    return () => {
      registerStepUpRequester(null);
      coordinator.dispose();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    setData(null);
    setConnectionError(false);
    setAuthenticationRequired(false);
    setAuthorizationDenied(false);
    loadBootstrap()
      .then((result) => {
        if (!mounted) return;
        if (postLoginRedirect.current) {
          const permittedPath = defaultPathFor(result.data.capabilities);
          postLoginRedirect.current = false;
          window.history.replaceState({}, '', browserPathFor(permittedPath, import.meta.env.BASE_URL));
          setPath(permittedPath);
          if (permittedPath === '/unauthorized') {
            setAuthorizationDenied(true);
            return;
          }
          setData(result.data);
          return;
        }
        if (!canAccessPath(path, result.data.capabilities)) {
          const permittedPath = defaultPathFor(result.data.capabilities);
          if (permittedPath === '/unauthorized') {
            window.history.replaceState({}, '', browserPathFor(permittedPath, import.meta.env.BASE_URL));
            setAuthorizationDenied(true);
            return;
          }
          window.history.replaceState({}, '', browserPathFor(permittedPath, import.meta.env.BASE_URL));
          setPath(permittedPath);
          return;
        }
        setData(result.data);
      })
      .catch((error) => {
        if (!mounted) return;
        setData(null);
        if (error instanceof ApiError && error.status === 401) setAuthenticationRequired(true);
        else if (error instanceof ApiError && error.status === 403) setAuthorizationDenied(true);
        else setConnectionError(true);
      });
    return () => { mounted = false; };
  }, [path, retryKey]);

  useEffect(() => {
    const onPopState = () => setPath(initialPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const actorName = useMemo(() => data?.actor.name ?? '사용자', [data]);

  function navigate(nextPath: string) {
    if (data && !canAccessPath(nextPath, data.capabilities)) return;
    window.history.pushState({}, '', browserPathFor(nextPath, import.meta.env.BASE_URL));
    setPath(nextPath);
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  async function logout() {
    if (logoutPending) return;
    setLogoutPending(true);
    setLogoutError('');
    try {
      await logoutV2();
      stepUpCoordinator.current?.cancel(new ApiError(401, 'SESSION_ENDED', '로그아웃으로 작업이 종료되었습니다.'));
      setData(null);
      setAuthorizationDenied(false);
      setAuthenticationRequired(true);
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : '로그아웃하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setLogoutPending(false);
    }
  }

  function authenticated(_actor: PublicActor) {
    postLoginRedirect.current = true;
    setAuthenticationRequired(false);
    setAuthorizationDenied(false);
    setRetryKey((value) => value + 1);
  }

  function currentSessionRevoked() {
    stepUpCoordinator.current?.cancel(new ApiError(401, 'SESSION_REVOKED', '자격정보 변경으로 다시 로그인해야 합니다.'));
    postLoginRedirect.current = false;
    setData(null);
    setAuthorizationDenied(false);
    setAuthenticationRequired(true);
    setLogoutError('');
  }

  async function completeStepUp(password: string, code: string) {
    await stepUpV2(password, code);
    stepUpCoordinator.current?.complete();
  }

  function cancelStepUp() {
    stepUpCoordinator.current?.cancel();
  }

  function notify(message: string, tone: Toast['tone'] = 'info') {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4_500);
  }

  if (connectionError) return <ApiConnectionError onRetry={() => setRetryKey((value) => value + 1)} />;
  if (authenticationRequired) return <LoginScreen onAuthenticated={authenticated} />;
  if (authorizationDenied) return <UnauthorizedScreen onLogout={logout} logoutError={logoutError} logoutPending={logoutPending} />;
  if (!data) return <SkeletonScreen />;
  if (path === '/unauthorized') return <UnauthorizedScreen onLogout={logout} logoutError={logoutError} logoutPending={logoutPending} />;

  return (
    <AppShell role={role} path={path} actorName={actorName} actorRole={data.actor.role} storeName={data.store.name} deliveryCount={data.deliveries.length} capabilities={data.capabilities} onNavigate={navigate} onLogout={logout} logoutPending={logoutPending}>
      {logoutError && <div className="logout-recovery" role="alert"><div><strong>로그아웃을 완료하지 못했습니다</strong><p>{logoutError} 현재 로그인 상태는 유지됩니다.</p></div><Button type="button" variant="secondary" onClick={logout} disabled={logoutPending}>로그아웃 다시 시도</Button><Button type="button" variant="ghost" onClick={() => setLogoutError('')}>계속 사용</Button></div>}
      {path === '/store/orders' && <StoreOrdersPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/store/documents' && <StoreDocumentsPage data={data} notify={notify} />}
      {path === '/hq/orders' && <HqOrdersPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/delivery' && <HqDeliveryPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/reconciliation' && <HqReconciliationPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/invoices' && <HqInvoicesPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      {path === '/hq/accounts' && <HqAccountsPage data={data} notify={notify} onCurrentSessionRevoked={currentSessionRevoked} />}
      {path === '/driver/today' && <DriverTodayPage data={data} notify={notify} refresh={() => setRetryKey((value) => value + 1)} />}
      <ToastRegion toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
      {stepUpOpen && <StepUpDialog onSubmit={completeStepUp} onCancel={cancelStepUp} />}
    </AppShell>
  );
}
