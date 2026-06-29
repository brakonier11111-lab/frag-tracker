(() => {
    const parseFloatParam = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    };

    const parseBooleanValue = (value, fallback) => {
        if (value === null || value === undefined || value === '') return fallback;
        if (typeof value === 'boolean') return value;
        const normalized = String(value).toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        return fallback;
    };

    const configBase = window.__lastDonationConfig || {};
    const queryParams = new URLSearchParams(window.location.search);
    const frameEnabled = parseBooleanValue(queryParams.get('frame'), parseBooleanValue(configBase.frame, true));
    const opacityCandidate = parseFloatParam(queryParams.get('opacity')) ?? parseFloatParam(configBase.opacity);
    const opacityValue = Math.min(Math.max(opacityCandidate ?? 0.95, 0.05), 1);
    const BASE_NAME_SIZE = 1.2;
    const MIN_NAME_SIZE = 0.7;
    let lastDonation = null;
    let wsConnection = null;

    const formatDuration = (value) => {
        const seconds = Math.max(0, Math.floor(value || 0));
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        const parts = [];
        if (d) parts.push(`${d}д`);
        if (h) parts.push(`${h}ч`);
        if (m) parts.push(`${m}м`);
        if (s) parts.push(`${s}с`);
        if (!parts.length) {
            return '+0с';
        }
        return `+${parts.join(' ')}`;
    };

    const adjustNameSize = () => {
        const container = document.getElementById('donorName');
        const nameEl = document.getElementById('donorNameInner');
        if (!container || !nameEl) return;
        requestAnimationFrame(() => {
            let fontSize = BASE_NAME_SIZE;
            nameEl.style.fontSize = `${fontSize}rem`;
            const maxWidth = container.clientWidth;
            while (fontSize > MIN_NAME_SIZE && nameEl.scrollWidth > maxWidth) {
                fontSize = Math.max(MIN_NAME_SIZE, fontSize - 0.05);
                nameEl.style.fontSize = `${fontSize}rem`;
            }
        });
    };

    const renderDonation = (donation) => {
        const containerName = document.getElementById('donorNameInner');
        const amountEl = document.getElementById('donorAmount');
        const timeEl = document.getElementById('donorTime');
        const lastEntry = document.getElementById('lastEntry');
        const noDonation = document.getElementById('noDonation');
        
        if (!donation || !containerName || !amountEl || !timeEl) {
            if (lastEntry) lastEntry.style.display = 'none';
            if (noDonation) noDonation.style.display = 'block';
            return;
        }

        if (lastEntry) lastEntry.style.display = 'flex';
        if (noDonation) noDonation.style.display = 'none';

        containerName.textContent = donation.username || '—';
        amountEl.textContent = `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(donation.amount || 0)} ₽`;
        timeEl.textContent = formatDuration(donation.time_earned);
        adjustNameSize();
    };

    const lastEntry = document.getElementById('lastEntry');
    const noDonation = document.getElementById('noDonation');
    const widgetEl = document.querySelector('.last-widget');
    
    if (widgetEl) {
        const bgColor = `rgba(8, 8, 15, ${opacityValue})`;
        const borderAlpha = 0.1 * opacityValue;
        widgetEl.style.setProperty('--bg-color', bgColor);
        widgetEl.style.setProperty('--border-color', `rgba(255, 255, 255, ${borderAlpha})`);
        if (!frameEnabled) {
            widgetEl.classList.add('no-frame');
        } else {
            widgetEl.classList.remove('no-frame');
        }
    }

    const fetchLastDonation = async () => {
        if (!lastEntry || !noDonation) return;
        try {
            const response = await fetch('/api/donations?limit=1', { cache: 'no-store' });
            const data = await response.json();
            const donations = Array.isArray(data.donations) ? data.donations : [];
            
            if (!donations.length) {
                lastDonation = null;
                renderDonation(null);
                return;
            }

            lastDonation = donations[0];
            renderDonation(lastDonation);
        } catch (error) {
            console.error('Ошибка загрузки последнего доната:', error);
            renderDonation(null);
        }
    };

    const connectWebSocket = () => {
        if (wsConnection) {
            wsConnection.close();
            wsConnection = null;
        }
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const connectionUrl = `${protocol}//${window.location.host}/ws?type=widget`;
        wsConnection = new WebSocket(connectionUrl);
        wsConnection.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'NEW_DONATION' || data.type === 'STATE_UPDATE') {
                    fetchLastDonation();
                }
            } catch (e) {
                console.warn('Last donation WS parse error', e);
            }
        });
        wsConnection.addEventListener('close', () => setTimeout(connectWebSocket, 3000));
    };

    const init = () => {
        fetchLastDonation();
        setInterval(fetchLastDonation, 60000);
        connectWebSocket();
        window.addEventListener('resize', adjustNameSize);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

