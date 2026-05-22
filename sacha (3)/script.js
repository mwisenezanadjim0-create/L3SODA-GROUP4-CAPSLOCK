document.addEventListener('DOMContentLoaded', () => {
    const preloader = document.getElementById('preloader');

    // --- Header navigation extras (Opening times / Find us map) ---
    // Requirement: when someone clicks OPENING TIMES, also show the location map.
    // Requirement: FIND US keeps whatsapp + phone number links unchanged (no contact text changes).
    const openTimesBtn = document.querySelector('a.header-order[data-scroll="opening"]');
    const findUsBtn = document.querySelector('a.header-order[data-scroll="findus"]');
    const findUsMapEl = document.getElementById('findUsMap');

    const scrollToMapAndFocus = () => {
        if (!findUsMapEl) return;
        findUsMapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Nudge iframe load by focusing the map container.
        setTimeout(() => {
            try { findUsMapEl.focus?.(); } catch (e) {}
        }, 250);
    };

    if (openTimesBtn) {
        openTimesBtn.addEventListener('click', (e) => {
            // Let the browser follow the anchor, then force map into view.
            // Still works even if anchor doesn't exist in some cases.
            setTimeout(scrollToMapAndFocus, 100);
        });
    }

    if (findUsBtn) {
        findUsBtn.addEventListener('click', () => {
            setTimeout(scrollToMapAndFocus, 100);
        });
    }

    
    // Function to hide preloader
    const hidePreloader = () => {
        setTimeout(() => {
            if (preloader) preloader.classList.add('fade-out');
            document.body.classList.remove('loading');
        }, 3000); // 3 seconds presentation
    };

    // Trigger hide on window load or immediately if already loaded
    if (document.readyState === 'complete') {
        hidePreloader();
    } else {
        window.addEventListener('load', hidePreloader);
    }

    
    setTimeout(() => {
        if (preloader && !preloader.classList.contains('fade-out')) {
            preloader.classList.add('fade-out');
            document.body.classList.remove('loading');
        }
    }, 6000); // 6 seconds max fallback

    const burgerBtn = document.getElementById('burgerBtn');
    const navOverlay = document.getElementById('navOverlay');
    const navLinks = document.querySelectorAll('.nav-links a, .header-logo a');

    if (burgerBtn) {
        burgerBtn.addEventListener('click', () => {
            burgerBtn.classList.toggle('active');
            navOverlay.classList.toggle('active');
            document.body.style.overflow = navOverlay.classList.contains('active') ? 'hidden' : '';
        });
    }

    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            if (burgerBtn) burgerBtn.classList.remove('active');
            if (navOverlay) navOverlay.classList.remove('active');
            document.body.style.overflow = '';
        });
    });

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(e => {
            if (e.isIntersecting) {
                e.target.classList.add('visible');
                if (e.target.id === 'credits') {
                    initCinemaMode();
                }
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('section, .menu-item, footer').forEach((el, index) => {
        el.style.opacity = '0';
        if (el.classList.contains('menu-item')) {
            el.style.transform = 'translateX(-30px)';
            el.style.transition = `all 0.6s cubic-bezier(0.22, 1, 0.36, 1) ${index % 3 * 0.1}s`;
        } else {
            el.style.transform = 'translateY(30px)';
            el.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
        }
        observer.observe(el);
    });

    const style = document.createElement('style');
    style.textContent = `
        section.visible, footer.visible, .credits.visible { opacity: 1 !important; transform: translateY(0) !important; }
        .menu-item.visible { opacity: 1 !important; transform: translateX(0) !important; }
    `;
    document.head.appendChild(style);

    const header = document.querySelector('.header');
    window.addEventListener('scroll', () => {
        if (header) {
            header.style.boxShadow = window.scrollY > 10
                ? '0 4px 30px rgba(0,0,0,0.5)'
                : 'none';
        }
    });

    // --- CART FUNCTIONALITY ---
    const cartBtn = document.getElementById('cartBtn');
    const cartSidebar = document.getElementById('cartSidebar');
    const cartClose = document.getElementById('cartClose');
    const cartOverlay = document.getElementById('cartOverlay');
    const cartItemsList = document.getElementById('cartItemsList');
    const cartCount = document.querySelector('.cart-count');
    const cartTotalValue = document.getElementById('cartTotalValue');

    let cart = [];

    const setCartOpen = (isOpen) => {
        if (cartSidebar && cartOverlay) {
            cartSidebar.classList.toggle('active', isOpen);
            cartOverlay.classList.toggle('active', isOpen);
            document.body.style.overflow = isOpen ? 'hidden' : '';
        }
    };

    const parsePrice = (value) => {
        const numeric = String(value || '').replace(/[^\d]/g, '');
        return Number(numeric) || 0;
    };

    const formatPrice = (value) => `${Number(value || 0).toLocaleString()} RWF`;

    const getCartItemFromButton = (btn) => {
        const menu3dItem = btn.closest('.menu-3d-item');
        const menuCard = btn.closest('.menu-item-card');
        const name = btn.dataset.name
            || menu3dItem?.querySelector('h3')?.textContent
            || menuCard?.querySelector('.item-name')?.textContent
            || 'Menu item';
        const img = btn.dataset.img
            || menu3dItem?.querySelector('img')?.getAttribute('src')
            || menuCard?.querySelector('img')?.getAttribute('src')
            || '';
        const priceText = btn.dataset.price
            || menu3dItem?.querySelector('.price')?.textContent
            || menuCard?.querySelector('.item-price')?.textContent
            || '0';
        const price = parsePrice(priceText);

        return {
            id: `${name.trim()}-${price}`,
            name: name.trim(),
            img,
            price,
            quantity: 1
        };
    };

    const addToCart = (item) => {
        const existing = cart.find(cartItem => cartItem.id === item.id);
        if (existing) existing.quantity += 1;
        else cart.push(item);
        updateCart();
    };

    if (cartBtn) cartBtn.addEventListener('click', () => setCartOpen(true));
    if (cartClose) cartClose.addEventListener('click', () => setCartOpen(false));
    if (cartOverlay) cartOverlay.addEventListener('click', () => setCartOpen(false));

    const updateCart = () => {
        const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
        if (cartCount) cartCount.textContent = itemCount;

        if (cart.length === 0) {
            if (cartItemsList) cartItemsList.innerHTML = '<p class="empty-msg">Your cart is empty</p>';
            if (cartTotalValue) cartTotalValue.textContent = '0 RWF';
            return;
        }

        if (cartItemsList) {
            cartItemsList.innerHTML = '';
            let total = 0;

            cart.forEach((item, index) => {
                total += item.price * item.quantity;
                
                const card = document.createElement('div');
                card.className = 'cart-item-card';
                card.innerHTML = `
                    <img src="${item.img}" class="cart-item-img" alt="${item.name}">
                    <div class="cart-item-info">
                        <h4>${item.name}</h4>
                        <p>${formatPrice(item.price)} x ${item.quantity}</p>
                    </div>
                    <button class="cart-remove" data-remove-index="${index}" aria-label="Remove ${item.name}">
                        <i class="fas fa-trash"></i>
                    </button>
                `;
                cartItemsList.appendChild(card);
            });

            if (cartTotalValue) cartTotalValue.textContent = formatPrice(total);
        }
    };

    if (cartItemsList) {
        cartItemsList.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('[data-remove-index]');
            if (!removeBtn) return;
            cart.splice(Number(removeBtn.dataset.removeIndex), 1);
            updateCart();
        });
    }

    // --- SUCCESS MODAL ---
    const checkoutBtn = document.getElementById('checkoutBtn');
    const orderSuccess = document.getElementById('orderSuccess');
    const successClose = document.getElementById('successClose');
    const successDone = document.getElementById('successDone');

    if (checkoutBtn) {
        const deliveryModal = document.getElementById('deliveryModal');
        const deliveryModalClose = document.getElementById('deliveryModalClose');
        const deliveryCancel = document.getElementById('deliveryCancel');
        const deliveryForm = document.getElementById('deliveryForm');
        const deliveryConfirm = document.getElementById('deliveryConfirm');

        const openDeliveryModal = () => {
            if (!deliveryModal) return;
            deliveryModal.classList.add('active');
            deliveryModal.setAttribute('aria-hidden', 'false');
            setTimeout(() => {
                document.getElementById('customerName')?.focus();
            }, 100);
        };

        const closeDeliveryModal = () => {
            if (!deliveryModal) return;
            deliveryModal.classList.remove('active');
            deliveryModal.setAttribute('aria-hidden', 'true');
        };

        if (deliveryModalClose) deliveryModalClose.addEventListener('click', closeDeliveryModal);
        if (deliveryCancel) deliveryCancel.addEventListener('click', closeDeliveryModal);

        if (checkoutBtn) {
            checkoutBtn.addEventListener('click', () => {
                if (cart.length === 0) {
                    alert('Your cart is empty!');
                    return;
                }

                // Don’t show questions inside the cart.
                // Instead show a clean modal before confirming delivery.
                openDeliveryModal();
            });
        }

        if (deliveryForm) {
            deliveryForm.addEventListener('submit', (e) => {
                e.preventDefault();

                const nameEl = document.getElementById('customerName');
                const phoneEl = document.getElementById('customerPhone');
                const addressEl = document.getElementById('deliveryAddress');

                const customerName = (nameEl?.value || '').trim();
                const customerPhone = (phoneEl?.value || '').trim();
                const deliveryAddress = (addressEl?.value || '').trim();

                if (!customerName || customerName.length < 2) {
                    alert('Please enter the name of the person ordering.');
                    nameEl?.focus();
                    return;
                }

                if (!customerPhone || customerPhone.length < 7) {
                    alert('Please enter a valid phone number.');
                    phoneEl?.focus();
                    return;
                }

                if (!deliveryAddress || deliveryAddress.length < 5) {
                    alert('Please enter your location / delivery address.');
                    addressEl?.focus();
                    return;
                }

                closeDeliveryModal();
                setCartOpen(false);

                setTimeout(() => {
                    if (orderSuccess) orderSuccess.classList.add('active');
                    cart = [];
                    updateCart();
                }, 500);
            });
        }
    }

    const closeSuccess = () => {
        if (orderSuccess) orderSuccess.classList.remove('active');
        document.body.style.overflow = '';
    };

    if (successClose) successClose.addEventListener('click', closeSuccess);
    if (successDone) successDone.addEventListener('click', closeSuccess);

    // --- PREMIUM 3D MENU CAROUSEL LOGIC ---
    const menu3d = document.getElementById('menu3d');
    const items3d = document.querySelectorAll('.menu-3d-item');
    const prev3d = document.getElementById('prev3d');
    const next3d = document.getElementById('next3d');
    const currentIndicator = document.querySelector('.nav-indicator .current');
    const totalIndicator = document.querySelector('.nav-indicator .total');
    const progressFill = document.querySelector('.progress-fill');
    
    let active3d = 0;
    const total3d = items3d.length;

    if (totalIndicator) totalIndicator.textContent = total3d.toString().padStart(2, '0');

    const update3d = () => {
        if (currentIndicator) currentIndicator.textContent = (active3d + 1).toString().padStart(2, '0');
        if (progressFill) progressFill.style.width = `${((active3d + 1) / total3d) * 100}%`;

        items3d.forEach((item, i) => {
            let offset = i - active3d;
            
            // Handle circular wrapping
            if (offset > total3d / 2) offset -= total3d;
            if (offset < -total3d / 2) offset += total3d;

            const absOffset = Math.abs(offset);
            const isCenter = i === active3d;
            
            item.classList.toggle('active', isCenter);
            
            // Premium 3D Transform Calculation
            // Physics-based spacing and rotation
            const xOffset = offset * 320; 
            const zOffset = absOffset * -300;
            const yRotation = offset * -45;
            const scale = 1 - absOffset * 0.15;
            const opacity = 1 - absOffset * 0.4;

            item.style.transform = `translateX(${xOffset}px) translateZ(${zOffset}px) rotateY(${yRotation}deg) scale(${scale})`;
            item.style.opacity = opacity;
            item.style.zIndex = 100 - absOffset;
            
            // Disable interactions for background items
            item.style.pointerEvents = absOffset > 1 ? 'none' : 'auto';
        });
    };

    if (next3d) next3d.addEventListener('click', () => {
        active3d = (active3d + 1) % total3d;
        update3d();
    });

    if (prev3d) prev3d.addEventListener('click', () => {
        active3d = (active3d - 1 + total3d) % total3d;
        update3d();
    });

    // Support keyboard navigation
    window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') {
            active3d = (active3d + 1) % total3d;
            update3d();
        } else if (e.key === 'ArrowLeft') {
            active3d = (active3d - 1 + total3d) % total3d;
            update3d();
        }
    });

    // Auto-play with pause on interaction
    let autoPlayInterval = setInterval(() => {
        active3d = (active3d + 1) % total3d;
        update3d();
    }, 6000);

    const resetAutoPlay = () => {
        clearInterval(autoPlayInterval);
        autoPlayInterval = setInterval(() => {
            active3d = (active3d + 1) % total3d;
            update3d();
        }, 6000);
    };

    if (menu3d) {
        menu3d.addEventListener('mouseenter', () => clearInterval(autoPlayInterval));
        menu3d.addEventListener('mouseleave', resetAutoPlay);
    }

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.add-to-cart, .add-to-cart-plus');
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();

        addToCart(getCartItemFromButton(btn));
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i>';
        btn.classList.add('is-added');

        setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.classList.remove('is-added');
        }, 1200);
    });

    // --- CINEMATIC END CREDITS TIMELINE CONTROLLER ---
    let isAudioPlaying = false;
    let isCrawlPaused = false;
    let audioCtx = null;
    let droneOsc1 = null;
    let droneOsc2 = null;
    let droneGain = null;
    let filterNode = null;
    let noiseSource = null;
    let noiseGain = null;
    let popInterval = null;

    const startCinematicAudio = () => {
        try {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }

            // 1. Warm Low Cinematic Pad Drone (Root C2 = 65.4Hz)
            droneOsc1 = audioCtx.createOscillator();
            droneOsc2 = audioCtx.createOscillator();
            droneGain = audioCtx.createGain();
            filterNode = audioCtx.createBiquadFilter();

            droneOsc1.type = 'sawtooth';
            droneOsc1.frequency.setValueAtTime(65.4, audioCtx.currentTime);
            droneOsc1.detune.setValueAtTime(-10, audioCtx.currentTime);

            droneOsc2.type = 'triangle';
            droneOsc2.frequency.setValueAtTime(65.4, audioCtx.currentTime);
            droneOsc2.detune.setValueAtTime(10, audioCtx.currentTime);

            // Resonant low-pass for warmth
            filterNode.type = 'lowpass';
            filterNode.frequency.setValueAtTime(110, audioCtx.currentTime);
            filterNode.Q.setValueAtTime(3.5, audioCtx.currentTime);

            // Modulate filter frequency slowly with LFO (0.15Hz) for evolving textures
            const lfo = audioCtx.createOscillator();
            const lfoGain = audioCtx.createGain();
            lfo.type = 'sine';
            lfo.frequency.setValueAtTime(0.15, audioCtx.currentTime);
            lfoGain.gain.setValueAtTime(35, audioCtx.currentTime); // sweep range

            lfo.connect(lfoGain);
            lfoGain.connect(filterNode.frequency);
            lfo.start();

            droneGain.gain.setValueAtTime(0, audioCtx.currentTime);
            droneGain.gain.linearRampToValueAtTime(0.24, audioCtx.currentTime + 3); // smooth fade-in

            droneOsc1.connect(filterNode);
            droneOsc2.connect(filterNode);
            filterNode.connect(droneGain);
            droneGain.connect(audioCtx.destination);

            droneOsc1.start();
            droneOsc2.start();

            // 2. Realistic Crackling Woodfire Sizzle (Filtered Noise)
            const bufferSize = audioCtx.sampleRate * 2.5; 
            const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
            const output = noiseBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                output[i] = Math.random() * 2 - 1;
            }

            noiseSource = audioCtx.createBufferSource();
            noiseSource.buffer = noiseBuffer;
            noiseSource.loop = true;

            const noiseFilter = audioCtx.createBiquadFilter();
            noiseFilter.type = 'highpass';
            noiseFilter.frequency.setValueAtTime(2300, audioCtx.currentTime);

            noiseGain = audioCtx.createGain();
            noiseGain.gain.setValueAtTime(0, audioCtx.currentTime);
            noiseGain.gain.linearRampToValueAtTime(0.012, audioCtx.currentTime + 2.5); // subtle backdrop

            noiseSource.connect(noiseFilter);
            noiseFilter.connect(noiseGain);
            noiseGain.connect(audioCtx.destination);
            noiseSource.start();

            // 3. Dynamic Wood Charcoal Sparks (Random popping bursts)
            popInterval = setInterval(() => {
                if (Math.random() > 0.45) { // 55% trigger chance
                    const popOsc = audioCtx.createOscillator();
                    const popGain = audioCtx.createGain();
                    const popFilter = audioCtx.createBiquadFilter();

                    popOsc.type = Math.random() > 0.5 ? 'triangle' : 'sine';
                    popOsc.frequency.setValueAtTime(950 + Math.random() * 2200, audioCtx.currentTime);

                    popFilter.type = 'bandpass';
                    popFilter.frequency.setValueAtTime(1400 + Math.random() * 1800, audioCtx.currentTime);
                    popFilter.Q.setValueAtTime(1.5, audioCtx.currentTime);

                    popGain.gain.setValueAtTime(0.05 + Math.random() * 0.07, audioCtx.currentTime);
                    popGain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.008 + Math.random() * 0.025);

                    popOsc.connect(popFilter);
                    popFilter.connect(popGain);
                    popGain.connect(audioCtx.destination);

                    popOsc.start();
                    popOsc.stop(audioCtx.currentTime + 0.06);
                }
            }, 190);

        } catch (e) {
            console.error('Web Audio Synth failed:', e);
        }
    };

    const stopCinematicAudio = () => {
        clearInterval(popInterval);
        try {
            if (droneGain) droneGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.8);
            if (noiseGain) noiseGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.8);

            setTimeout(() => {
                if (droneOsc1) droneOsc1.stop();
                if (droneOsc2) droneOsc2.stop();
                if (noiseSource) noiseSource.stop();
                if (audioCtx) audioCtx.suspend();
            }, 900);
        } catch (e) {}
    };

    // --- Floating Embers Generator ---
    let embersInterval = null;
    const startEmbers = () => {
        const container = document.getElementById('creditsParticles');
        if (!container) return;

        // Spawn initial background sparks instantly
        for (let i = 0; i < 15; i++) {
            spawnEmber(container, true);
        }

        embersInterval = setInterval(() => {
            spawnEmber(container, false);
        }, 160);
    };

    const spawnEmber = (container, isInitial = false) => {
        const ember = document.createElement('span');
        ember.className = 'ember';

        const size = Math.random() * 7 + 3; // 3px to 10px
        const left = Math.random() * 100; 
        const drift = (Math.random() * 140 - 70) + 'px'; // dynamic drift direction
        const duration = Math.random() * 4 + 4; // 4s to 8s
        const delay = isInitial ? -(Math.random() * duration) : 0;

        ember.style.width = `${size}px`;
        ember.style.height = `${size}px`;
        ember.style.left = `${left}%`;
        ember.style.setProperty('--drift', drift);
        ember.style.animationDuration = `${duration}s`;
        if (delay !== 0) {
            ember.style.animationDelay = `${delay}s`;
        }

        container.appendChild(ember);

        setTimeout(() => {
            ember.remove();
        }, duration * 1000);
    };

    const stopEmbers = () => {
        clearInterval(embersInterval);
        const container = document.getElementById('creditsParticles');
        if (container) container.innerHTML = '';
    };

    // --- Cinema Mode Controller ---
    let isCinemaInitialized = false;
    window.initCinemaMode = () => {
        if (isCinemaInitialized) return;
        isCinemaInitialized = true;

        const creditsSection = document.getElementById('credits');
        const creditsScroll = document.getElementById('creditsScroll');
        const creditsFinalCard = document.getElementById('creditsFinalCard');
        const creditsSoundToggle = document.getElementById('creditsSoundToggle');
        const btnPauseCrawl = document.getElementById('btnPauseCrawl');
        const btnSkipCrawl = document.getElementById('btnSkipCrawl');
        const btnReplayCredits = document.getElementById('btnReplayCredits');
        const creditsControls = document.getElementById('creditsControls');

        if (!creditsSection || !creditsScroll) return;

        // Start visuals silently to respect autoplay policies
        startEmbers();
        creditsSection.classList.add('playing');

        // Playback Controls
        if (creditsSoundToggle) {
            creditsSoundToggle.addEventListener('click', () => {
                if (isAudioPlaying) {
                    stopCinematicAudio();
                    isAudioPlaying = false;
                    creditsSoundToggle.classList.remove('playing');
                    creditsSoundToggle.querySelector('.sound-text').textContent = 'SOUND OFF';
                } else {
                    startCinematicAudio();
                    isAudioPlaying = true;
                    creditsSoundToggle.classList.add('playing');
                    creditsSoundToggle.querySelector('.sound-text').textContent = 'SOUND ON';
                }
            });
        }

        if (btnPauseCrawl) {
            btnPauseCrawl.addEventListener('click', () => {
                if (isCrawlPaused) {
                    isCrawlPaused = false;
                    creditsScroll.style.animationPlayState = 'running';
                    btnPauseCrawl.innerHTML = '<i class="fas fa-pause"></i> PAUSE';
                } else {
                    isCrawlPaused = true;
                    creditsScroll.style.animationPlayState = 'paused';
                    btnPauseCrawl.innerHTML = '<i class="fas fa-play"></i> RESUME';
                }
            });
        }

        const showFinalCard = () => {
            creditsScroll.style.opacity = '0';
            creditsScroll.style.pointerEvents = 'none';
            if (creditsFinalCard) creditsFinalCard.classList.add('visible');
            if (creditsControls) {
                creditsControls.style.opacity = '0';
                creditsControls.style.visibility = 'hidden';
            }
        };

        if (btnSkipCrawl) {
            btnSkipCrawl.addEventListener('click', showFinalCard);
        }

        // Listen for animation naturally scrolling off screen
        creditsScroll.addEventListener('animationend', (e) => {
            if (e.animationName === 'creditsMove') {
                showFinalCard();
            }
        });

        // Interactive climax replays
        if (btnReplayCredits) {
            btnReplayCredits.addEventListener('click', () => {
                if (creditsFinalCard) creditsFinalCard.classList.remove('visible');
                creditsScroll.style.opacity = '';
                creditsScroll.style.pointerEvents = '';

                if (creditsControls) {
                    creditsControls.style.opacity = '';
                    creditsControls.style.visibility = '';
                }

                isCrawlPaused = false;
                if (btnPauseCrawl) btnPauseCrawl.innerHTML = '<i class="fas fa-pause"></i> PAUSE';
                creditsScroll.style.animationPlayState = 'running';

                creditsSection.classList.remove('playing');
                void creditsScroll.offsetWidth; // reflow trigger
                creditsSection.classList.add('playing');
            });
        }
    };

    // Consideration: Suspend Audio context when leaving the tab
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (audioCtx && audioCtx.state === 'running') {
                audioCtx.suspend();
            }
        } else {
            if (isAudioPlaying && audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
        }
    });

    // Initialize state
    update3d();
});
