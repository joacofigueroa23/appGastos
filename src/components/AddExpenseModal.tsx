import { ManualExpenseForm } from './ManualExpenseForm';
import React, { useState, useEffect } from 'react';
import { useFinance } from '../context/FinanceContext';
import { EXPENSE_CATEGORIES as CATEGORIES, PAYMENT_METHODS } from '../data/financeCatalog';
import { manualExpenseFromFields, selectableCards, todayDateOnly } from '../utils/finance';
import {
  X,
  Sparkles,
  Receipt,
  CreditCard as CardIcon,
  Check,
  Loader2,
  Calendar,
} from 'lucide-react';

interface AddExpenseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AddExpenseModal: React.FC<AddExpenseModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { members, cards, activeMemberId, addExpense, isDemoMode } = useFinance();

  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  const [aiText, setAiText] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiFeedback, setAiFeedback] = useState<string | null>(null);

  // Formulario manual
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<string>('');
  const [cardId, setCardId] = useState<string>('');
  const [paidByMemberId, setPaidByMemberId] = useState<string>(activeMemberId);
  const [isShared, setIsShared] = useState<boolean>(true);
  const [installmentTotal, setInstallmentTotal] = useState<number>(1);
  const [installmentCurrent, setInstallmentCurrent] = useState<number>(1);
  const [date, setDate] = useState<string>(
    todayDateOnly()
  );
  const [notes, setNotes] = useState('');

  const [formError, setFormError] = useState<string | null>(null);
  const availableCards = selectableCards(cards);
  useEffect(() => {
    if (isOpen) {
      setPaidByMemberId(activeMemberId);
      setDate(todayDateOnly());
      setCategory('');
      setPaymentMethod('');
      setCardId('');
      setMode('manual');
      setFormError(null);
    }
  }, [isOpen, activeMemberId]);

  if (!isOpen) return null;
  if (!isDemoMode) return <ManualExpenseForm onClose={onClose}/>;

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      addExpense(manualExpenseFromFields({
        description, amount, category, date, paymentMethod, cardId,
        reportedByMemberId: paidByMemberId, installmentTotal, installmentCurrent, notes,
      }, availableCards));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'No se pudo guardar el gasto.');
      return;
    }

    handleClose();
  };

  const handleAiParse = async () => {
    if (!aiText.trim()) return;
    setIsAiLoading(true);
    setAiFeedback(null);

    try {
      const activeMember = members.find((m) => m.id === paidByMemberId);
      const res = await fetch('/api/gemini/parse-expense', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: aiText,
          memberName: activeMember?.name,
          knownCards: availableCards.map((c) => c.name),
        }),
      });

      const data = await res.json();
      if (data.success && data.data) {
        const item = data.data;
        if (item.currency && item.currency !== 'ARS') {
          setAiFeedback('La carga manual trabaja en ARS. No se convierte automáticamente otra moneda.');
          return;
        }
        setCategory('');
        setPaymentMethod('');
        setCardId('');
        setDescription(item.description || '');
        setAmount(item.amount == null ? '' : String(item.amount));
        if (item.category && CATEGORIES.includes(item.category)) {
          setCategory(item.category);
        }
        if (item.paymentMethod && PAYMENT_METHODS.includes(item.paymentMethod)) {
          setPaymentMethod(item.paymentMethod);
        }
        setInstallmentCurrent(item.installmentCurrent ?? 1);
        if (item.date) setDate(item.date);
        if (item.installmentTotal) {
          setInstallmentTotal(item.installmentTotal);
        }
        setAiFeedback('Revisa los datos extraídos y completa los faltantes antes de guardar.');
        setMode('manual');
      } else {
        setAiFeedback('No se pudo extraer la información automáticamente. Por favor completa los campos.');
      }
    } catch (e) {
      console.error(e);
      setAiFeedback('Error al consultar el motor de inteligencia artificial.');
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleClose = () => {
    setDescription('');
    setAmount('');
    setAiText('');
    setAiFeedback(null);
    setNotes('');
    setCategory('');
    setPaymentMethod('');
    setCardId('');
    setIsShared(true);
    setFormError(null);
    setInstallmentTotal(1);
    setInstallmentCurrent(1);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-lg w-full overflow-hidden transition-all">
        
        {/* Cabecera */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <Receipt className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Registrar Nuevo Gasto</h3>
              <p className="text-xs text-slate-500">Registra un gasto de la economía familiar</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Selector de Modo: Manual o AI Rápido */}
        <div className="px-6 pt-4">
          <div className="grid grid-cols-2 p-1 bg-slate-100 rounded-xl gap-1">
            <button
              type="button"
              onClick={() => setMode('manual')}
              className={`py-2 text-xs font-semibold rounded-lg transition-all ${
                mode === 'manual'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Carga Manual Detallada
            </button>
            <button
              type="button"
              onClick={() => setMode('ai')}
              className={`flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                mode === 'ai'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Autocompletar con IA</span>
            </button>
          </div>
        </div>

        {/* Modo AI */}
        {mode === 'ai' ? (
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Escribe como si lo mandaras por WhatsApp:
              </label>
              <textarea
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                placeholder="Ejemplo: Gasté $45.000 en el súper Carrefour con Visa en 3 cuotas"
                rows={3}
                className="w-full text-sm p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  'Supermercado Coto $34.000 en 1 pago Visa',
                  'Nafta YPF $28.000 débito',
                  'Farmacity $12.500 efectivo personal',
                ].map((sample, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setAiText(sample)}
                    className="text-[11px] bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200 px-2 py-1 rounded-md transition-colors text-left"
                  >
                    + {sample}
                  </button>
                ))}
              </div>
            </div>

            {aiFeedback && (
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-800">
                {aiFeedback}
              </div>
            )}

            <button
              type="button"
              onClick={handleAiParse}
              disabled={isAiLoading || !aiText.trim()}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-all cursor-pointer"
            >
              {isAiLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Procesando mensaje con Gemini 3.8 Flash...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Completar Formulario con IA</span>
                </>
              )}
            </button>
          </div>
        ) : (
          /* Formulario Manual */
          <form onSubmit={handleManualSubmit} className="p-6 space-y-4">
            {formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
            
            {aiFeedback && (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{aiFeedback}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Descripción */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Descripción del Gasto *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Supermercado Coto, Nafta, Factura Luz"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              {/* Monto */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Monto Total ($ ARS) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full text-sm font-mono tabular-nums px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              {/* Fecha */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Fecha *
                </label>
                <div className="relative">
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                  <Calendar className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
                </div>
              </div>

              {/* Categoría */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Categoría *
                </label>
                <select
                  value={category}
                  required
                  aria-label="Categoría"
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                >
                  <option value="">Selecciona una categoría</option>
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              {/* Miembro que pagó */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Informado por *
                </label>
                <select
                  value={paidByMemberId}
                  required
                  aria-label="Informado por"
                  onChange={(e) => setPaidByMemberId(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                >
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.avatar} {m.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Método de Pago */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Medio de Pago *
                </label>
                <select
                  value={paymentMethod}
                  required
                  aria-label="Medio de pago"
                  onChange={(e) => { setPaymentMethod(e.target.value); setCardId(''); }}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                >
                  <option value="">Selecciona un medio de pago</option>
                  {PAYMENT_METHODS.map((pm) => (
                    <option key={pm} value={pm}>
                      {pm}
                    </option>
                  ))}
                </select>
              </div>

              {/* Tarjeta vinculada (si es crédito) */}
              {(paymentMethod === 'Tarjeta de Crédito' || paymentMethod === 'Tarjeta de Débito') && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Tarjeta (opcional)
                  </label>
                  <select
                    value={cardId}
                    aria-label="Tarjeta opcional"
                    onChange={(e) => setCardId(e.target.value)}
                    className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                  >
                    <option value="">Sin tarjeta especificada</option>
                    {availableCards.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Cuotas (si es crédito) */}
              {paymentMethod === 'Tarjeta de Crédito' && (
                <div className="sm:col-span-2 grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Total de Cuotas
                    </label>
                    <select
                      value={installmentTotal}
                      onChange={(e) => {
                        const total = Number(e.target.value);
                        setInstallmentTotal(total);
                        setInstallmentCurrent((current) => Math.min(current, total));
                      }}
                      className="w-full text-sm px-3 py-1.5 border border-slate-300 rounded-lg bg-white"
                    >
                      {[1, 2, 3, 6, 9, 12, 18, 24].map((n) => (
                        <option key={n} value={n}>
                          {n === 1 ? '1 pago (Sin cuotas)' : `${n} cuotas fijas`}
                        </option>
                      ))}
                    </select>
                  </div>

                  {installmentTotal > 1 && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Cuota Actual que se Paga
                      </label>
                      <input
                        type="number"
                        min="1"
                        max={installmentTotal}
                        value={installmentCurrent}
                        onChange={(e) => setInstallmentCurrent(parseInt(e.target.value, 10) || 1)}
                        className="w-full text-sm px-3 py-1.5 border border-slate-300 rounded-lg bg-white font-mono tabular-nums"
                      />
                    </div>
                  )}

                  {installmentTotal > 1 && amount && (
                    <div className="col-span-2 text-xs text-slate-600 pt-1 font-mono">
                      Monto aproximado por cuota:{' '}
                      <strong className="text-slate-900">
                        ${(Number(amount) / installmentTotal).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </strong>
                    </div>
                  )}
                </div>
              )}

              {/* Destino del gasto: Común o Personal */}
              <details className="sm:col-span-2 pt-1">
                <summary className="text-xs text-slate-500">Opciones anteriores: fuera de prioridad actual</summary>
                <fieldset disabled className="mt-2">
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isShared}
                    onChange={(e) => setIsShared(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                  />
                  <span className="text-xs font-semibold text-slate-800">
                    Gasto Común del Hogar (se divide en el balance familiar)
                  </span>
                </label>
                <p className="text-[11px] text-slate-500 ml-6.5 mt-0.5">
                  {isShared
                    ? 'Se contabiliza para el presupuesto general de la familia.'
                    : 'Gasto individual propio de quien lo pagó (no se reclama compensación).'}
                </p>
                </fieldset>
                <p className="text-xs text-slate-500">La carga actual pertenece a una única economía familiar.</p>
              </details>

              {/* Notas opcionales */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Notas o Detalle (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ej. Ticket guardado, garantía de 1 año"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

            </div>

            {/* Acciones */}
            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-colors"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-all shadow-sm shadow-blue-500/20 cursor-pointer"
              >
                Guardar Gasto
              </button>
            </div>

          </form>
        )}

      </div>
    </div>
  );
};
