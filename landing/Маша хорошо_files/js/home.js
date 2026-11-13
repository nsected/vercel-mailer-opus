
const form_exercise = document.getElementById("leadForm");
const form_course = document.getElementById("courseForm");

const leadModal = document.getElementById("leadModal");
const courseModal = document.getElementById("courseModal");

const successModal = document.getElementById("successModal");
const errorModal = document.getElementById("errorModal");

console.log("courseModal:", courseModal);
console.log("leadModal:", leadModal);
console.log("successModal:", successModal);
console.log("errorModal:", errorModal);

console.log("Bootstrap version:", bootstrap?.Modal?.VERSION);

console.log(
    "Bootstrap instances:",
    courseModal
        ? bootstrap.Modal.getInstance(courseModal)
        : "courseModal не найден"
);

// ================================================
// ОБРАБОТЧИК ФОРМЫ ЗАЯВКИ НА ЗАНЯТИЕ
// ================================================

form_exercise.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
        const response = await fetch(form_exercise.action, {
            method: "POST",
            body: new URLSearchParams(new FormData(form_exercise))
        });

        // Определяем результат отправки
        const resultModal = response.ok ? successModal : errorModal;

        if (response.ok) {
            form_exercise.reset();
        } else {
            console.error("Ошибка сервера:", response.status);
        }

        // Показываем результат после закрытия формы
        leadModal.addEventListener("hidden.bs.modal", () => {
            bootstrap.Modal
                .getOrCreateInstance(resultModal)
                .show();
        }, { once: true });

        // Закрываем модальное окно заявки
        bootstrap.Modal
            .getOrCreateInstance(leadModal)
            .hide();

    } catch (error) {
        console.error("Ошибка отправки заявки:", error);

        leadModal.addEventListener("hidden.bs.modal", () => {
            bootstrap.Modal
                .getOrCreateInstance(errorModal)
                .show();
        }, { once: true });

        bootstrap.Modal
            .getOrCreateInstance(leadModal)
            .hide();
    }
});


// ================================================
// ОБРАБОТЧИК ФОРМЫ ПОКУПКИ КУРСА
// ================================================

form_course.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
        const response = await fetch(form_course.action, {
            method: "POST",
            body: new URLSearchParams(new FormData(form_course))
        });

        // Определяем результат отправки
        const resultModal = response.ok ? successModal : errorModal;

        if (response.ok) {
            form_course.reset();
        } else {
            console.error("Ошибка сервера:", response.status);
        }

        // Показываем результат после закрытия формы курса
        courseModal.addEventListener("hidden.bs.modal", () => {
            bootstrap.Modal
                .getOrCreateInstance(resultModal)
                .show();
        }, { once: true });

        // Закрываем именно окно покупки курса
        bootstrap.Modal
            .getOrCreateInstance(courseModal)
            .hide();

    } catch (error) {
        console.error("Ошибка отправки заказа курса:", error);

        courseModal.addEventListener("hidden.bs.modal", () => {
            bootstrap.Modal
                .getOrCreateInstance(errorModal)
                .show();
        }, { once: true });

        bootstrap.Modal
            .getOrCreateInstance(courseModal)
            .hide();
    }
});