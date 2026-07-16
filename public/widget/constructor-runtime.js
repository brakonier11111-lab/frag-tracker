'use strict';
/**
 * Общий рантайм для рендерера конструктора виджетов (/widget/custom/:id).
 * Стили элементов задаются как preset + custom-оверрайды (тот же паттерн,
 * что и в widget/donation-goal.html: applyBarVisualThemeWidget/preset lookup),
 * но обобщены на произвольный тип элемента, а не только progress-bar.
 */

const STYLE_PRESETS = {
    classic: { fontFamily: 'Inter, sans-serif', color: '#ffffff', background: 'rgba(20,20,30,0.85)', borderRadius: 8, glow: 'none' },
    minimal: { fontFamily: 'Inter, sans-serif', color: '#f5f5f5', background: 'transparent', borderRadius: 0, glow: 'none' },
    neon: { fontFamily: 'Inter, sans-serif', color: '#00ff9d', background: 'rgba(8,8,20,0.9)', borderRadius: 12, glow: 'medium' },
    gradient: { fontFamily: 'Inter, sans-serif', color: '#ffffff', background: 'linear-gradient(135deg,#b300ff,#00d4ff)', borderRadius: 12, glow: 'soft' },
    dark: { fontFamily: 'Inter, sans-serif', color: '#e5e5e5', background: 'rgba(0,0,0,0.9)', borderRadius: 6, glow: 'none' },
    colorful: { fontFamily: 'Inter, sans-serif', color: '#ffffff', background: 'linear-gradient(135deg,#ff6a00,#ffd200)', borderRadius: 16, glow: 'strong' }
};

const GLOW_SHADOW = {
    none: 'none',
    soft: '0 0 10px rgba(255,255,255,0.25)',
    medium: '0 0 20px rgba(0,255,157,0.45)',
    strong: '0 0 32px rgba(255,210,0,0.6)'
};

function resolveElementStyle(style) {
    const preset = style && style.preset && STYLE_PRESETS[style.preset] ? STYLE_PRESETS[style.preset] : STYLE_PRESETS.classic;
    const custom = (style && style.preset === 'custom' && style.custom) ? style.custom : {};
    return Object.assign({}, preset, custom);
}

// Внедряет <style> с уникальным keyframes-анимацией по имени, чтобы не плодить
// коллизии между виджетами на одной странице (паттерн из createLiquidGradientAnimation).
let animCounter = 0;
function injectPulseAnimation(el, colorFrom, colorTo, speedSec) {
    const name = 'wc-pulse-' + (animCounter++);
    const styleTag = document.createElement('style');
    styleTag.textContent = `@keyframes ${name} { 0%,100% { box-shadow: 0 0 10px ${colorFrom}; } 50% { box-shadow: 0 0 24px ${colorTo}; } }`;
    document.head.appendChild(styleTag);
    el.style.animation = `${name} ${speedSec || 2}s ease-in-out infinite`;
}

function applyElementStyle(el, style) {
    const resolved = resolveElementStyle(style);
    el.style.fontFamily = resolved.fontFamily || 'Inter, sans-serif';
    if (resolved.fontSize) el.style.fontSize = resolved.fontSize + 'px';
    el.style.color = resolved.color || '#fff';
    el.style.background = resolved.background || 'transparent';
    el.style.borderRadius = (resolved.borderRadius != null ? resolved.borderRadius : 8) + 'px';
    el.style.boxShadow = GLOW_SHADOW[resolved.glow] || 'none';

    if (resolved.animation === 'pulse') {
        injectPulseAnimation(el, resolved.color || '#fff', resolved.background || '#fff', resolved.animationSpeed || 2);
    }

    // Escape hatch: сырой CSS, скоуплен через уникальный класс на элементе.
    if (resolved.customCss) {
        const scopeClass = 'wc-custom-' + (animCounter++);
        el.classList.add(scopeClass);
        const styleTag = document.createElement('style');
        styleTag.textContent = `.${scopeClass} { ${resolved.customCss} }`;
        document.head.appendChild(styleTag);
    }
}

function getByPath(obj, path) {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function formatValue(value) {
    if (value == null) return '';
    if (typeof value === 'boolean') return value ? 'да' : 'нет';
    if (typeof value === 'number') return Math.round(value * 100) / 100;
    return String(value);
}
