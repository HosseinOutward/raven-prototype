package http

import "sync"

// keyedMutex gives each key its own lock and forgets a key once nobody holds or waits
// for it.
//
// Chat uses it with the conversation id. A change to a conversation holds its lock from
// before the transaction until its events are queued, so events leave in the order the
// changes were committed, and requests queueing for the same conversation wait here
// rather than each holding a database connection.
//
// It only orders work inside this process. The row lock taken by the transaction is what
// keeps sequence numbers correct.
type keyedMutex struct {
	mu    sync.Mutex
	locks map[string]*keyedLock
}

type keyedLock struct {
	mu      sync.Mutex
	holders int
}

func newKeyedMutex() *keyedMutex {
	return &keyedMutex{locks: map[string]*keyedLock{}}
}

// lock blocks until the key is free and returns the function that releases it.
func (k *keyedMutex) lock(key string) func() {
	k.mu.Lock()
	entry := k.locks[key]
	if entry == nil {
		entry = &keyedLock{}
		k.locks[key] = entry
	}
	entry.holders++
	k.mu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		k.mu.Lock()
		entry.holders--
		if entry.holders == 0 {
			delete(k.locks, key)
		}
		k.mu.Unlock()
	}
}
