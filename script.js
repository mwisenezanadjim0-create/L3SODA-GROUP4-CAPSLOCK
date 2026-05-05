document.addEventListener('DOMContentLoaded', () => {
    // Scroll reveal
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(e => {
            if (e.isIntersecting) {
                e.target.classList.add('visible');
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('section').forEach(s => {
        s.style.opacity = '0';
        s.style.transform = 'translateY(30px)';
        s.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
        observer.observe(s);
    });

    // Watch for visible class
    const style = document.createElement('style');
    style.textContent = `section.visible { opacity: 1 !important; transform: translateY(0) !important; }`;
    document.head.appendChild(style);

    // Header scroll shrink
    const header = document.querySelector('.header');
    window.addEventListener('scroll', () => {
        header.style.boxShadow = window.scrollY > 10
            ? '0 4px 30px rgba(0,0,0,0.5)'
            : 'none';
    });
});
