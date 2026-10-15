import React from 'react';
import { useFinance } from '../context/FinanceContext';
import {
  Wallet,
  Calendar,
  Receipt,
  BarChart3,
  CreditCard,
  MessageCircle,
  Users,
} from 'lucide-react';

interface NavbarProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
}) => {
  const { members, activeMemberId, setActiveMemberId, isDemoMode, apiMembers=[] } = useFinance();
  const currentMember = members.find((m) => m.id === activeMemberId) || members[0];

  const selectableMembers=isDemoMode?members:members.filter(m=>apiMembers.some(api=>api.id===m.id&&api.active));
  const navItems = [
    { id: 'dashboard', label: 'Panel Central', icon: Wallet },
    { id: 'calendar', label: 'Vencimientos & Tarjetas', icon: Calendar },
    { id: 'expenses', label: 'Historial de Gastos', icon: Receipt },
    { id: 'analysis', label: 'Patrones & Balances', icon: BarChart3 },
    ...(!isDemoMode?[{id:'family',label:'Tarjetas e integrantes',icon:Users}]:[]),
  ];

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200/80 shadow-2xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          
          {/* Zona 1: Brand Title */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => onSelectTab('dashboard')}
              className="flex items-center gap-2.5 text-left focus:outline-none group cursor-pointer"
            >
              <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold text-lg shadow-sm group-hover:bg-blue-700 transition-colors">
                <CreditCard className="w-5 h-5 text-white" />
              </div>
              <div>
                <span className="text-lg font-bold tracking-tight text-slate-900 group-hover:text-blue-600 transition-colors">
                  GastosFamilia
                </span>
              </div>
            </button>

            {/* Chip discreto del WhatsApp conectado */}
            <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 text-emerald-800 text-[11px] font-semibold rounded-full border border-emerald-200/70">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <MessageCircle className="w-3.5 h-3.5 text-emerald-600" />
              <span>WhatsApp: agregar</span>
            </div>
          </div>

          {/* Zona 2: Enlaces de Navegación Claros y Concisos */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelectTab(item.id)}
                  className={`flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap cursor-pointer ${
                    isActive
                      ? 'bg-blue-50 text-blue-700 font-bold'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-blue-600' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Zona 3: Acciones primarias */}
          <div className="flex items-center gap-2.5 shrink-0">
            
            {/* Selector de Miembro */}
            <div className="flex items-center gap-1.5 bg-slate-100/90 p-1 pl-2.5 pr-1.5 rounded-xl border border-slate-200/60">
              <span className="text-base select-none" aria-hidden="true">
                {currentMember?.avatar || '●'}
              </span>
              <select
                aria-label="Seleccionar miembro de la familia"
                value={activeMemberId}
                onChange={(e) => setActiveMemberId(e.target.value)}
                className="text-xs font-semibold text-slate-800 bg-transparent border-0 focus:ring-0 cursor-pointer pr-1 py-1 outline-none"
              >
                <option value="">Sin integrante especificado</option>
                {selectableMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name.split(' ')[0]}
                  </option>
                ))}
              </select>
            </div>


          </div>

        </div>

        {/* Barra Móvil de Pestañas */}
        <div className="flex md:hidden overflow-x-auto py-2 border-t border-slate-100 gap-1 scrollbar-none">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 transition-colors ${
                  isActive
                    ? 'bg-blue-50 text-blue-700 font-bold border border-blue-200/60'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
};
