import React from 'react';
import { useFinance } from '../context/FinanceContext';
import { useAuth, useRole } from '../context/AuthContext';
import { Wallet, LayoutDashboard, Calendar, Receipt, BarChart3, Users, UserRound, LogOut, PiggyBank, CalendarClock } from 'lucide-react';

interface SidebarProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
}

// Visible solo al pasar el mouse o con foco de teclado en pantallas anchas; en el celular es una barra inferior.
const reveal = 'md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity duration-150';

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab }) => {
  const { members, activeMemberId, setActiveMemberId, isDemoMode, apiMembers = [] } = useFinance();
  const { mode, member: me, signOut } = useAuth();
  const session = mode === 'session', admin = useRole() === 'admin';
  const currentMember = members.find((m) => m.id === activeMemberId) || members[0];
  const selectableMembers = isDemoMode ? members : members.filter((m) => apiMembers.some((api) => api.id === m.id && api.active));
  // Modo real: el integrante solo ve su panel y su historial; el resto es del administrador (y el backend lo exige igual).
  const navItems = isDemoMode ? [
    { id: 'dashboard', label: 'Panel Central', icon: LayoutDashboard },
    { id: 'calendar', label: 'Vencimientos & Tarjetas', icon: Calendar },
    { id: 'expenses', label: 'Historial de Gastos', icon: Receipt },
    { id: 'analysis', label: 'Patrones & Balances', icon: BarChart3 },
  ] : [
    { id: 'dashboard', label: 'Panel Central', icon: LayoutDashboard },
    { id: 'expenses', label: 'Historial de Gastos', icon: Receipt },
    ...(admin ? [{ id: 'budgets', label: 'Presupuestos', icon: PiggyBank }, { id: 'fixed', label: 'Gastos fijos', icon: CalendarClock }] : []),
    ...(admin ? [{ id: 'family', label: 'Tarjetas e integrantes', icon: Users }] : []),
    ...(session ? [{ id: 'profile', label: 'Mi perfil', icon: UserRound }] : []),
  ];

  return (
    <aside
      aria-label="Navegación principal"
      className="group fixed z-40 bg-rail text-white flex
        max-md:inset-x-0 max-md:bottom-0 max-md:h-16 max-md:items-center max-md:gap-1 max-md:px-2
        md:inset-y-0 md:left-0 md:w-16 md:hover:w-60 md:focus-within:w-60 md:flex-col md:gap-1 md:px-2 md:py-4 md:overflow-hidden md:transition-[width] md:duration-200 md:ease-out"
    >
      <button
        onClick={() => onSelectTab('dashboard')}
        className="max-md:hidden flex items-center gap-3 h-11 px-1.5 mb-4 rounded-xl text-left whitespace-nowrap"
      >
        <span className="w-9 h-9 shrink-0 rounded-xl bg-accent grid place-items-center">
          <Wallet className="w-5 h-5" aria-hidden="true" />
        </span>
        <span className={`text-base font-bold tracking-tight ${reveal}`}>GastosFamilia</span>
      </button>

      <nav className="flex md:flex-col gap-1 max-md:flex-1 max-md:justify-around">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 h-11 rounded-xl px-3 whitespace-nowrap transition-colors max-md:justify-center max-md:px-3 ${
                active ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Icon className={`w-5 h-5 shrink-0 ${active ? 'text-accent-soft' : ''}`} aria-hidden="true" />
              <span className={`text-sm font-medium max-md:sr-only ${reveal}`}>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {session ? (
        <button
          onClick={() => void signOut()}
          title={me?.name}
          className="md:mt-auto flex items-center gap-3 h-11 rounded-xl px-3 whitespace-nowrap text-slate-400 hover:text-white hover:bg-white/5 max-md:justify-center"
        >
          <LogOut className="w-5 h-5 shrink-0" aria-hidden="true" />
          <span className={`text-sm font-medium max-md:sr-only ${reveal}`}>Cerrar sesión</span>
        </button>
      ) : (
      <label className="md:mt-auto flex items-center gap-3 h-11 px-3 rounded-xl text-slate-300 hover:bg-white/5">
        <span className="w-5 shrink-0 text-center text-base max-md:hidden" aria-hidden="true">
          {currentMember?.avatar || '●'}
        </span>
        <select
          aria-label="Seleccionar miembro de la familia"
          value={activeMemberId}
          onChange={(e) => setActiveMemberId(e.target.value)}
          className={`bg-transparent text-sm outline-none max-md:w-20 max-md:text-xs md:w-36 [&>option]:text-slate-900 ${reveal}`}
        >
          <option value="">Sin integrante especificado</option>
          {selectableMembers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name.split(' ')[0]}
            </option>
          ))}
        </select>
      </label>
      )}
    </aside>
  );
};
