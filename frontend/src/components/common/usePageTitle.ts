import { useEffect } from 'react'

const APP_NAME = 'MeetAI'

/**
 * Set the document title for the lifetime of a page.
 *
 * Pass the page's own name; the product name is appended. Pass nothing (or
 * an empty string) for the bare product name. The previous title is restored
 * on unmount so a transient view (a dialog, a wizard step) can borrow the tab
 * title and hand it back.
 */
export function usePageTitle(title?: string | null) {
    useEffect(() => {
        const previous = document.title
        document.title = title && title.trim() ? `${title.trim()} – ${APP_NAME}` : APP_NAME
        return () => {
            document.title = previous
        }
    }, [title])
}
